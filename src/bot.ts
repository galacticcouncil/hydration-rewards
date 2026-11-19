#!/usr/bin/env node
// The runner: keeps the hourly snapshots and the epochs up to date. An epoch is one day long unless
// the config says otherwise (epoch.lengthSeconds).
//
// Every tick it works out what is due from the files under the data directory alone, and does it,
// oldest first:
//   1. the snapshot of every hour that has ended since the start of the open epoch, the one after the
//      newest tree (an hour's block is picked by the block after it, so an hour is taken once it is over)
//   2. the close of every epoch whose snapshots are all there, each on the tree of the epoch before
//   3. public/latest.json, which tells the app who is earning as of the newest snapshot and what each
//      account has earned so far in the open epoch (an estimate, src/accruing.ts), and the newest
//      tree's claims file if it is missing
// There is no other state, so a restart, a crash or a day of downtime is caught up on the next tick
// (as long as the RPC node still has the state of the missed hours). A failure in one step does not
// stop the steps that do not depend on it: a snapshot that fails stops the snapshots, but epochs whose
// hours are all in are still closed. Every failure is reported and tried again on the next tick, and
// nothing is skipped.
//
// The program file is read once, at start, and a new one takes effect at its applies_from_epoch: every
// tick checks the loaded file against the stored epochs before it closes anything, so a restart with
// the wrong file is reported at once. The denylist is read on every tick, so a change to it applies
// from the next close. One runner per data directory: it holds <data>/bot.lock while it runs.
//
// A program file with an end (ends_at) is run up to it: no hour at or after the end is taken, and the
// epoch that ends there is the last one closed. From then on a tick takes and closes nothing, which is
// no failure: it says that the program ended, and still hands on the newest tree for posting.
//
// After each close it prints what the root-posting key has to submit. Given that key (PRIVKEY) and
// the distributor's address (URD_ADDRESS) it posts each root itself, and accepts it once the
// timelock has passed (src/post-roots.ts); without them it posts nothing.
//
// Usage:
//   node src/bot.ts --first-epoch 2026-12-15 [--program programs/htoken-no-hollar-borrowers.yaml]
//     [--data data] [--interval 60] [--once]
// With epochs shorter than a day the first epoch is the UTC date and hour it starts at: 2026-11-17T03.
// Environment, used when the flag is not given: FIRST_EPOCH, PROGRAM, DATA_DIR, BOT_INTERVAL_SECONDS,
// RPC_HYDRATION; and for posting PRIVKEY, URD_ADDRESS and, optionally, URD_GENESIS (the genesis hash
// the node's chain must have). A .env file in the repository root is read too (see .env.example).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { estimateAccruing, openEpochStatus } from "./accruing.ts";
import { closeEpochToDisk, epochWindow, loadEpochSnapshots, programProblem, storedTreeEpochs } from "./close-epoch.ts";
import { addEpochs, DAY, epochLength } from "./lib/epoch.ts";
import { loadDenylist } from "./lib/denylist.ts";
import { acquireLock, loadDotEnv, messageOf, readJson, sha256, toJson, writeText } from "./lib/io.ts";
import { makeRpc } from "./lib/rpc.ts";
import {
  postRoots,
  postingError,
  postingSettings,
  viemDistributor,
  type Distributor,
  type PostingStep,
} from "./post-roots.ts";
import { loadProgram, parseProgram } from "./program.ts";
import { claimsFile, claimsPath, latestFile, latestPath, publishLatest } from "./publish.ts";
import { snapshotHour } from "./snapshot.ts";
import type { Config, LoadedDenylist, Log, OpenEpoch, Program, Snapshot, Tree } from "./types.ts";

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// One pass. `takeHour(target)` takes and stores the snapshot of one hour.
// A pass that fails throws, and the error carries this status as `status`.
export interface TickStatus {
  // the first epoch without a tree, and how many of its snapshots exist. Once the program has ended
  // (ends_at) this file pays no such epoch: it is the one a program file that continues applies from.
  openEpoch: string;
  snapshots: number;
  // what this pass did
  taken: number[];
  closed: {
    epoch: string;
    root: string;
    treeSha256: string;
    paidAccounts: number;
    distributed: string;
    denylistProvisional: boolean;
  }[];
  latestTree: { epoch: string; root: string; sha256: string } | null;
  // the denylist this pass read, or null when it could not be read
  denylist: { sha256: string; provisional: boolean } | null;
  // why nothing more could be done, if anything is outstanding; or that the program has ended, and when
  waiting: string | null;
  // hours the chain produced no block in
  blocked: string[];
}

// The claims file of every stored tree, written again where it is missing: the app fetches the one of
// whatever root the URD holds, which is an older tree's for at least 12 hours after each close. The
// root comes from each epoch's summary, so a tree is only read when its file has to be written.
function restoreClaimsFiles(dataDir: string, epochs: string[], log: Log): void {
  for (const epoch of epochs) {
    const summaryPath = join(dataDir, "epochs", `${epoch}.summary.json`);
    const root = existsSync(summaryPath) ? readJson<{ tree?: { root?: string } }>(summaryPath).tree?.root : undefined;
    if (root !== undefined && existsSync(claimsPath(dataDir, root))) continue;
    const tree = readJson<Tree>(join(dataDir, "trees", `${epoch}.json`));
    if (existsSync(claimsPath(dataDir, tree.root))) continue;
    writeText(claimsPath(dataDir, tree.root), toJson(claimsFile(tree)));
    log(`wrote the missing claims file of ${epoch}'s root ${tree.root}`);
  }
}

export async function tick({
  now,
  dataDir,
  program,
  config,
  denylistPath,
  firstEpoch,
  takeHour,
  pendingProgramFrom = null,
  knownDenylist = null,
  maxBacklog = 72,
  log = () => {},
}: {
  now: number;
  dataDir: string;
  program: Program;
  config: Config;
  denylistPath: string;
  firstEpoch: string;
  takeHour: (target: number) => Promise<unknown>;
  // applies_from_epoch of a program file waiting on disk: the loaded file closes nothing from there on
  pendingProgramFrom?: string | null;
  // the denylist hash the last pass used, so a change is logged before a close uses it
  knownDenylist?: string | null;
  maxBacklog?: number;
  log?: Log;
}): Promise<TickStatus> {
  // The first epoch must be one of this program's: an id in the form of the configured epoch length
  // and, for epochs shorter than a day, an hour one of them starts at.
  const length = epochLength(config);
  epochWindow(firstEpoch, program.startHourUtc, length);
  // A tree from before the first epoch means the date is wrong: starting over from genesis here
  // would build a cumulative tree without the earlier epochs' amounts.
  const treesDir = join(dataDir, "trees");
  const trees = storedTreeEpochs(dataDir, length);
  const earlier = trees.filter((e) => e < firstEpoch);
  if (earlier.length > 0) {
    throw new Error(
      `the first epoch is ${firstEpoch}, but ${treesDir} already holds ${earlier[0]}.json; check the first epoch`,
    );
  }
  const perEpoch = config.epoch.snapshotsPerEpoch;
  const interval = length / perEpoch;
  const treePath = (epoch: string): string => join(dataDir, "trees", `${epoch}.json`);
  const hasSnapshot = (target: number): boolean => existsSync(join(dataDir, "snapshots", `${target}.json`));
  const hoursOf = (epoch: string): number[] => {
    const { start } = epochWindow(epoch, program.startHourUtc, length);
    return Array.from({ length: perEpoch }, (_, k) => start + k * interval);
  };
  // The program's end, when it has one (ends_at): a moment an epoch ends at, as the loader checked. No
  // hour at or after it is taken, and no epoch that ends after it is closed with this file.
  const endsAt = program.endsAt ?? Infinity;
  const pastEnd = (epoch: string): boolean => epochWindow(epoch, program.startHourUtc, length).end > endsAt;

  // The open epoch is the one after the newest tree: the chain goes on from its head, past any epoch
  // that was skipped by hand with --allow-gap.
  const newestTree = trees.length > 0 ? trees[trees.length - 1] : null;
  let epoch = newestTree === null ? firstEpoch : addEpochs(newestTree, 1, length);

  // A failure in one step does not stop the steps that do not depend on it. They are all reported
  // together at the end of the tick, which then counts as failed.
  const failures: Error[] = [];
  const fail = (what: string, error: unknown) =>
    failures.push(new Error(`${what}: ${messageOf(error)}`, { cause: error }));

  // What closing needs besides the snapshots. Without either, this pass closes nothing and leaves
  // latest.json alone, but still takes the snapshots that are due.
  let denylist: LoadedDenylist | null = null;
  let denylistChanged = false;
  try {
    denylist = loadDenylist(denylistPath);
    if (knownDenylist !== null && denylist.sha256 !== knownDenylist) {
      denylistChanged = true;
      log(
        `denylist changed to ${denylist.sha256}${denylist.provisional ? " (provisional)" : ""}; ` +
          "the closes from this pass on use it",
      );
    }
  } catch (error) {
    fail("denylist", error);
  }
  const programIssue = programProblem(dataDir, epoch, program, newestTree, length);
  if (programIssue !== null) failures.push(new Error(`program: ${programIssue}`));
  const canClose = denylist !== null && programIssue === null;

  // 1. Snapshots, for every hour from the open epoch's start that has ended by now, up to the program's end.
  const due: number[] = [];
  for (let target = hoursOf(epoch)[0]; target + interval <= now && target < endsAt; target += interval) {
    if (!hasSnapshot(target)) due.push(target);
  }
  if (due.length > maxBacklog) {
    const error = new Error(
      `${due.length} snapshots are overdue since ${iso(due[0])}, more than the ${maxBacklog} this runner catches up on ` +
        "its own; check the first epoch, or take them by hand with src/snapshot.ts",
    );
    throw Object.assign(error, { status: { openEpoch: epoch } });
  }
  const taken: number[] = [];
  const blocked: number[] = [];
  let waiting: string | null =
    now < hoursOf(firstEpoch)[0] ? `the first epoch starts at ${iso(hoursOf(firstEpoch)[0])}` : null;
  for (const target of due) {
    try {
      await takeHour(target);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "NOT_FINALIZED") {
        waiting = `the hour from ${iso(target)} is not over and finalized yet`;
        break; // later hours cannot be finalized either
      }
      // The chain produced no block inside this hour, so it can never be snapshotted. Later hours
      // are still taken; the epoch stays open until someone closes it by hand with --allow-partial.
      if (code === "NO_BLOCK_IN_HOUR") {
        blocked.push(target);
        continue;
      }
      // Anything else stops the snapshots. Epochs whose hours are all in are still closed below.
      fail(`snapshot of ${iso(target)}`, error);
      break;
    }
    taken.push(target);
    log(`snapshot ${iso(target)}`);
  }

  // 2. Closes, for every epoch that now has all its snapshots, up to the one that ends at the program's end.
  const closed: TickStatus["closed"] = [];
  if (canClose && denylist !== null) {
    try {
      while (!pastEnd(epoch) && hoursOf(epoch).every(hasSnapshot)) {
        // A merged program file waits on disk: from its first epoch on, the loaded file must not close.
        if (pendingProgramFrom !== null && epoch >= pendingProgramFrom) {
          failures.push(
            new Error(
              `program: the program file on disk applies from ${pendingProgramFrom}; ` +
                `restart the runner with it to close ${epoch}`,
            ),
          );
          break;
        }
        const genesis = epoch === firstEpoch;
        const { tree, summary, treeSha256 } = closeEpochToDisk({
          dataDir,
          epoch,
          program,
          config,
          denylist,
          now,
          genesis,
          previousTreePath: genesis ? null : treePath(addEpochs(epoch, -1, length)),
        });
        closed.push({
          epoch,
          root: tree.root,
          treeSha256,
          paidAccounts: summary.paidAccounts,
          distributed: summary.distributed,
          denylistProvisional: summary.denylist.provisional,
        });
        log(
          `epoch ${epoch} closed: ${summary.csv.rows} accounts paid, distributed ${summary.distributed}, dust ${summary.dust}\n` +
            `  to post: submitRoot(${tree.root}, ${treeSha256})` +
            (summary.denylist.provisional
              ? "\n  WARNING: the denylist is provisional, so accounts that should earn nothing may be in this tree"
              : ""),
        );
        epoch = addEpochs(epoch, 1, length);
      }
    } catch (error) {
      fail(`close of ${epoch}`, error);
    }
  }
  const stuck = blocked.filter((target) => hoursOf(epoch).includes(target));
  if (stuck.length > 0) {
    // --allow-partial pays the whole budget on the hours there are, so it waits until every other
    // hour of the epoch is in, which is just after the epoch ends (the closer waits an hour past it).
    const { end } = epochWindow(epoch, program.startHourUtc, length);
    const hours = stuck.map(iso).join(", ");
    const ready = now >= end + interval && hoursOf(epoch).every((h) => stuck.includes(h) || hasSnapshot(h));
    waiting = ready
      ? `epoch ${epoch} cannot close on its own: the chain produced no block inside ${hours}; ` +
        "close it by hand with --allow-partial"
      : `the chain produced no block inside ${hours}, so epoch ${epoch} cannot close on its own; once its other ` +
        `hours are all taken, from ${iso(end + interval)}, close it by hand with --allow-partial`;
  }
  // The program has ended once the epoch that ends at its end has a tree: the first epoch without one
  // is then an epoch this file never pays, so nothing is open and nothing is outstanding. It is the
  // epoch a program file that continues applies from.
  const ended = pastEnd(epoch);
  if (ended) {
    waiting =
      `the program ended at ${iso(endsAt)}: this program file takes no hour and closes no epoch from then on; ` +
      (pendingProgramFrom === epoch
        ? `restart the runner with the program file on disk, which applies from ${epoch}`
        : `to go on, restart the runner with a program file that applies from ${epoch}`);
    if (closed.length > 0) log(waiting);
  }

  const latest = addEpochs(epoch, -1, length);
  let latestTree: TickStatus["latestTree"] = null;
  if (existsSync(treePath(latest))) {
    const text = readFileSync(treePath(latest), "utf8");
    latestTree = { epoch: latest, root: (JSON.parse(text) as Tree).root, sha256: sha256(text) };
  }
  // A close writes each claims file before its tree; a tree closed by an older version, copied in, or
  // whose public folder was lost gets its file here.
  try {
    restoreClaimsFiles(dataDir, storedTreeEpochs(dataDir, length), log);
  } catch (error) {
    fail("claims files", error);
  }

  // 3. What the app reads. Rebuilt when this pass changed something or read another denylist than the
  // last one, and when the file is not what this pass would write: it is not there yet, another
  // program file wrote it (after a restart with a new one), a version from before the open epoch's
  // estimate wrote it, or it names another open epoch, snapshot count, newest snapshot or newest tree
  // than the data directory holds (an epoch closed or a snapshot taken by hand, or by a pass that
  // could not write the file). And while the estimate is missing because it failed: like every other
  // failure, that is tried again on every pass. A pass that finds none of this reads no snapshot.
  //
  // The budgets of one epoch are the program's daily ones scaled to the epoch's length and rounded
  // down, as in a close (closeEpochToDisk): all of the day's when epochs are one day long.
  // A close refuses a blank budget. The estimate is left out (null) instead, which is no failure and
  // nothing to try again. It is left out as well for an epoch this file may not close because a newer
  // one waits on disk (pendingProgramFrom): that file will pay it, with budgets and rules that are
  // not loaded here. The file is rebuilt when such a file arrives, and when it is taken back.
  //
  // Once the program has ended no epoch is open: the file says so with "openEpoch": null and stays at
  // the newest snapshot before the end, so a pass after that finds it up to date and reads nothing.
  const epochBudgets = new Map<string, bigint | null>();
  for (const [asset, budget] of program.budgetPerDay) {
    epochBudgets.set(asset, budget === null ? null : (budget * BigInt(length)) / BigInt(DAY));
  }
  const budgetsDecided = [...epochBudgets.values()].every((budget) => budget !== null);
  const heldForNewFile = pendingProgramFrom !== null && epoch >= pendingProgramFrom;
  const first = hoursOf(firstEpoch)[0];
  let newest = Math.min(first + Math.floor((now - first) / interval) * interval, endsAt - interval);
  while (newest >= first && !hasSnapshot(newest)) newest -= interval;
  const inEpoch = hoursOf(epoch).filter(hasSnapshot).length;
  const outdated = (): boolean => {
    let published: {
      asOf?: { hour?: number };
      program?: { sha256?: string };
      latestTree?: { root?: string } | null;
      openEpoch?: { id?: string; snapshots?: number; accruing?: unknown } | null;
    } | null;
    try {
      published = readJson(latestPath(dataDir));
    } catch {
      return true;
    }
    const openEpoch = published?.openEpoch;
    if (
      published?.program?.sha256 !== program.sha256 ||
      published?.asOf?.hour !== newest ||
      (published?.latestTree?.root ?? null) !== (latestTree?.root ?? null)
    ) {
      return true;
    }
    if (ended) return openEpoch !== null;
    return (
      typeof openEpoch !== "object" ||
      openEpoch === null ||
      openEpoch.id !== epoch ||
      openEpoch.snapshots !== inEpoch ||
      (openEpoch.accruing === null ? budgetsDecided && !heldForNewFile : heldForNewFile)
    );
  };
  if (canClose && denylist !== null && (taken.length > 0 || closed.length > 0 || denylistChanged || outdated())) {
    if (newest >= first) {
      // The open epoch, unless the program has ended, and an estimate of what each account has earned in
      // it so far, unless a newer program file will pay it: from the snapshots of its hours that exist,
      // read and checked the way a close reads them. An estimate that fails is left out (null) and the
      // file is written without it. It is reported like any other failure: the pass has taken its
      // snapshots and closed its epochs by now and still hands on the newest tree for posting, and what
      // stops the estimate (a snapshot that cannot be read, say) stops this epoch's close as well, so it
      // is known hours before that close is due.
      let openEpoch: OpenEpoch | null = null;
      if (!ended) {
        const window = epochWindow(epoch, program.startHourUtc, length);
        let accruing: Map<string, bigint> | null = null;
        if (!heldForNewFile) {
          try {
            const loaded =
              inEpoch === 0
                ? []
                : loadEpochSnapshots({
                    dir: join(dataDir, "snapshots"),
                    epoch,
                    window,
                    expected: perEpoch,
                    allowPartial: true,
                  });
            accruing = estimateAccruing({
              snapshots: loaded.map((l) => l.snapshot),
              expectedSnapshots: perEpoch,
              budgets: epochBudgets,
              eligibility: { maxHollarDebt: program.maxHollarDebt, earn: program.earn, denylist },
            });
          } catch (error) {
            fail(`estimate of the open epoch ${epoch}`, error);
          }
        }
        openEpoch = openEpochStatus({ id: epoch, window, snapshots: inEpoch, expectedSnapshots: perEpoch, accruing });
      }
      try {
        publishLatest(
          dataDir,
          latestFile({
            snapshot: readJson<Snapshot>(join(dataDir, "snapshots", `${newest}.json`)),
            program,
            reward: config.reward,
            denylist,
            latestTree: latestTree && { epoch: latestTree.epoch, root: latestTree.root },
            openEpoch,
          }),
        );
      } catch (error) {
        fail("public/latest.json", error);
      }
    }
  }

  const status: TickStatus = {
    openEpoch: epoch,
    snapshots: hoursOf(epoch).filter(hasSnapshot).length,
    taken,
    closed,
    latestTree,
    denylist: denylist && { sha256: denylist.sha256, provisional: denylist.provisional },
    waiting,
    blocked: blocked.map(iso),
  };
  if (failures.length > 0) {
    const error =
      failures.length === 1 ? failures[0] : new AggregateError(failures, failures.map(messageOf).join("; also "));
    throw Object.assign(error, { status });
  }
  return status;
}

// The program file on disk when it is not the one this runner loaded: a merged change waiting for a
// restart. Restart once the epoch before its applies_from_epoch is closed, and before that one closes.
export function programOnDisk(
  path: string,
  config: Config,
  loaded: Program,
): { sha256?: string; appliesFromEpoch?: string | null; error?: string } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { error: messageOf(error) };
  }
  const onDisk = sha256(text);
  if (onDisk === loaded.sha256) return null;
  try {
    return { sha256: onDisk, appliesFromEpoch: parseProgram(text, config, { source: path }).appliesFromEpoch };
  } catch (error) {
    return { sha256: onDisk, error: messageOf(error) };
  }
}

// The epoch from which the loaded file must stop closing: the applies_from_epoch of a program file on
// disk that takes over later than the loaded one. A file that would not (an edit that kept the date,
// an older file put back) is only reported: it would be refused anyway, and the loaded one keeps running.
export function pendingProgramFrom(onDisk: ReturnType<typeof programOnDisk>, loaded: Program): string | null {
  const from = onDisk?.appliesFromEpoch;
  return from && loaded.appliesFromEpoch !== null && from > loaded.appliesFromEpoch ? from : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  loadDotEnv(root);
  const env = process.env;
  const { values: a } = parseArgs({
    options: {
      "first-epoch": { type: "string", default: env.FIRST_EPOCH },
      program: { type: "string", default: env.PROGRAM || join(root, "programs", "htoken-no-hollar-borrowers.yaml") },
      data: { type: "string", default: env.DATA_DIR || join(root, "data") },
      interval: { type: "string", default: env.BOT_INTERVAL_SECONDS || "60" },
      once: { type: "boolean", default: false },
      config: { type: "string", default: join(root, "config", "mainnet.json") },
      denylist: { type: "string", default: join(root, "config", "denylist.json") },
      rpc: { type: "string" },
    },
  });
  if (!a["first-epoch"])
    throw new Error("--first-epoch (or FIRST_EPOCH) is required: the date of the very first epoch");
  const intervalSeconds = Number(a.interval);
  if (!(intervalSeconds >= 1)) throw new Error(`--interval must be a number of seconds, got ${a.interval}`);

  const config = readJson<Config>(a.config);
  // Budgets, the start hour and the program's first epoch must be decided before anything is paid,
  // so a blank stops the start. A denylist that does not load stops it too; it is read again every tick.
  const program = loadProgram(a.program, config, { requireDecisions: true });
  const startDenylist = loadDenylist(a.denylist);
  const rpcUrl = a.rpc || env.RPC_HYDRATION || config.rpc;
  const rpc = makeRpc(rpcUrl, { batchSize: config.rpcBatchSize });
  // With PRIVKEY and URD_ADDRESS the runner posts each root itself (src/post-roots.ts); half of the
  // pair, or a key that is none, stops the start.
  const posting = postingSettings(env);
  const log: Log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const takeHour = (target: number) => snapshotHour({ rpc, config, dataDir: a.data, target, log });
  const statusPath = join(a.data, "status.json");

  // Two runners on one data directory would race on the holder index and on every output. The lock is
  // released on exit, which the signals below go through; every write is atomic, so stopping mid-tick is safe.
  acquireLock(join(a.data, "bot.lock"), `the data directory ${a.data}`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
  log(
    `program "${program.name}" (${program.sha256}) applies from ${program.appliesFromEpoch}` +
      `${program.endsAt === null ? "" : ` and ends at ${iso(program.endsAt)}`}; ` +
      `denylist ${startDenylist.sha256}${startDenylist.provisional ? " (provisional)" : ""}; ` +
      `first epoch ${a["first-epoch"]}, data in ${a.data}`,
  );
  log(
    posting === null
      ? "posting no roots: PRIVKEY and URD_ADDRESS are not set"
      : `posting roots to the distributor ${posting.address} as ${posting.account}`,
  );

  let lastProblem: string | null = null;
  let lastDenylist = startDenylist.sha256;
  let lastOnDisk = "null";
  let distributor: Distributor | null = null;
  let lastPosting = "";
  let lastPostingLogged = 0;
  for (;;) {
    // A merged program file on disk stops the loaded one from closing its epochs (see tick).
    const onDisk = programOnDisk(a.program, config, program);
    let status: Partial<TickStatus> = {};
    let problem: string | null = null;
    try {
      status = await tick({
        now: Math.floor(Date.now() / 1000),
        dataDir: a.data,
        program,
        config,
        denylistPath: a.denylist,
        firstEpoch: a["first-epoch"],
        takeHour,
        pendingProgramFrom: pendingProgramFrom(onDisk, program),
        knownDenylist: lastDenylist,
        log,
      });
    } catch (error) {
      problem = messageOf(error);
      status = (error as { status?: TickStatus }).status ?? {};
    }
    // The same failure every minute is logged once, and again when it clears.
    if (problem !== lastProblem) log(problem ? `FAILED, will retry: ${problem}` : "recovered");
    lastProblem = problem;
    if (status.denylist) lastDenylist = status.denylist.sha256;
    // Roots, when this runner posts them: one step a pass, after the closes. A pass that failed before
    // it knew the newest tree posts nothing. A failure here is reported and tried again next pass, and
    // never stops the snapshots or the closes.
    let postingStep: PostingStep | { action: "failed"; reason: string } | null = null;
    if (posting !== null && status.latestTree !== undefined) {
      try {
        distributor ??= await viemDistributor({ rpcUrl, chainId: config.chainId, ...posting });
        postingStep = await postRoots({ distributor, dataDir: a.data, newest: status.latestTree, log });
      } catch (error) {
        postingStep = { action: "failed", reason: postingError(error) };
      }
      // What it is waiting for, or why it posts nothing, is logged when it changes; a refusal or a
      // failure that stays is said again every hour, and its end is logged too.
      const line = "reason" in postingStep ? `${postingStep.action}: ${postingStep.reason}` : postingStep.action;
      const stuck = postingStep.action === "refuse" || postingStep.action === "failed";
      const wasStuck = /^(refuse|failed)/.test(lastPosting);
      if (line !== lastPosting || (stuck && Date.now() - lastPostingLogged >= 3_600_000)) {
        if ("reason" in postingStep && postingStep.action !== "none") {
          log(`posting roots, ${line}`);
          lastPostingLogged = Date.now();
        } else if (wasStuck) {
          log("posting roots: recovered");
        }
      }
      lastPosting = line;
    }
    if (JSON.stringify(onDisk) !== lastOnDisk) {
      lastOnDisk = JSON.stringify(onDisk);
      if (onDisk !== null) {
        log(
          `the program file on disk is not the one running (${onDisk.sha256 ?? onDisk.error}); ` +
            (pendingProgramFrom(onDisk, program) !== null
              ? `it applies from ${onDisk.appliesFromEpoch}, and the running file closes nothing from there on: ` +
                "restart once the epoch before it is closed"
              : onDisk.appliesFromEpoch
                ? `it applies from ${onDisk.appliesFromEpoch}, no later than the running file ` +
                  `(${program.appliesFromEpoch}), so it cannot take over as it is: every change moves ` +
                  "applies_from_epoch to an epoch that is not closed yet"
                : `it cannot be used: ${onDisk.error ?? "applies_from_epoch is blank"}`),
        );
      }
    }
    writeText(
      statusPath,
      toJson({
        tickedAt: new Date().toISOString(),
        program: { name: program.name, sha256: program.sha256, appliesFromEpoch: program.appliesFromEpoch },
        programOnDisk: onDisk,
        firstEpoch: a["first-epoch"],
        ...status,
        posting: postingStep,
        error: problem,
      }),
    );
    if (a.once) process.exit(problem ? 1 : 0);
    await sleep(intervalSeconds * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`bot: ${messageOf(error)}`);
    process.exit(1);
  });
}
