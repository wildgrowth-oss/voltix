// Runs bench/vs.ts several times, keeps each case's fastest result, and rewrites the benchmark
// tables in README.md, docs/comparison.md and every file passed with `--also`. Load only ever slows a
// case down, so the fastest of several passes is the closest to an idle run. It refuses to write while
// the machine is busy.
//
//   npm run bench:write                          five passes, then write
//   node scripts/bench-table.mjs --passes 7      more passes
//   node scripts/bench-table.mjs --also notes.md also rewrite the tables in notes.md
//   node scripts/bench-table.mjs --dry --save out.txt   run the passes, keep their output, write nothing
//   node scripts/bench-table.mjs --from out.txt         print the tables for a saved output
//   node scripts/bench-table.mjs --from out.txt --write  write the tables from a saved output
import { execFileSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const passes = Number(option('--passes', 5));
const maxLoad = Number(option('--max-load', 4));
const from = option('--from', null);
const save = option('--save', null);
const also = args.flatMap((arg, i) => (args[i - 1] === '--also' ? [arg] : []));
const write = from === null ? !args.includes('--dry') : args.includes('--write');

const COLUMNS = ['voltix', 'preact', 'zustand', 'nanostores', 'solid', 'valtio', 'jotai', 'legend'];

// Each table row, the bench scenario it reads, and the case behind each column. A mark follows the
// value in the table; a column with no case shows a dash.
const ROWS = [
  {
    label: 'update a value + notify',
    scenario: 'update a value + notify',
    cases: { voltix: 'voltix', preact: 'preact signals', zustand: 'zustand', nanostores: 'nanostores', solid: 'solid signals', valtio: 'valtio (notify async)', jotai: 'jotai', legend: 'legend-state' },
  },
  {
    label: 'functional update (`x => x + 1`)',
    scenario: 'functional update (x => x + 1)',
    cases: { voltix: 'voltix', preact: 'preact signals', zustand: 'zustand', nanostores: 'nanostores', solid: 'solid signals', valtio: 'valtio (notify async)', jotai: 'jotai', legend: 'legend-state' },
  },
  {
    label: 'fine-grained update (1 of 1000)',
    scenario: 'fine-grained update (1 of 1000)',
    cases: { voltix: 'voltix', preact: 'preact signals (1000 signals)', zustand: 'zustand (1000 stores)', nanostores: 'nanostores', solid: 'solid signals (1000 signals)', valtio: 'valtio (per-key subscribe is O(N))', jotai: 'jotai', legend: 'legend-state (1000 keys)' },
    marks: { zustand: '†', valtio: '‡' },
  },
  {
    label: 'notify 1000 subscribers',
    scenario: 'notify 1000 subscribers',
    cases: { voltix: 'voltix', preact: 'preact signals', zustand: 'zustand', nanostores: 'nanostores', solid: 'solid signals', jotai: 'jotai', legend: 'legend-state' },
    marks: { valtio: '‡' },
  },
  {
    label: 'update 50 keys as one transaction',
    scenario: 'update 50 keys as one transaction',
    cases: { voltix: 'voltix (batch)', preact: 'preact signals (batch)', zustand: 'zustand (setState K keys)', nanostores: 'nanostores (K atom sets)', solid: 'solid signals (batch)', jotai: 'jotai (K atom sets)', legend: 'legend-state (batch)' },
    marks: { valtio: '‡' },
  },
  {
    label: 'subscribe + unsubscribe',
    scenario: 'subscribe + unsubscribe',
    cases: { voltix: 'voltix', preact: 'preact signals (effect)', zustand: 'zustand', nanostores: 'nanostores', solid: 'solid signals (root + computed)', valtio: 'valtio (subscribeKey)', jotai: 'jotai', legend: 'legend-state' },
  },
  {
    label: 'create 1,000 units',
    scenario: 'create 1000 stores',
    cases: { voltix: 'voltix', preact: 'preact signals', zustand: 'zustand', nanostores: 'nanostores (atoms)', solid: 'solid signals', valtio: 'valtio (proxies)', jotai: 'jotai (atoms)', legend: 'legend-state (observables)' },
  },
];

// The same formatting bench/vs.ts prints.
const ops = (ns) => {
  const perSecond = 1e9 / ns;
  if (perSecond >= 1e6) return (perSecond / 1e6).toFixed(1) + 'M';
  if (perSecond >= 1e3) return Math.round(perSecond / 1e3) + 'K';
  return Math.round(perSecond).toString();
};

/** The fastest ns per `scenario\tcase` across every pass in `outputs`. */
function fastest(outputs) {
  const best = new Map();
  for (const output of outputs) {
    let scenario = null;
    for (const line of output.split('\n')) {
      const result = /^ {2}(.+?)\s{2,}\S+\s+\(([\d.]+) ns\)$/.exec(line);
      if (result) {
        const key = `${scenario}\t${result[1].trim()}`;
        const ns = Number(result[2]);
        if (!best.has(key) || ns < best.get(key)) best.set(key, ns);
      } else if (line.trim() && !line.startsWith('Node ') && !line.startsWith('ops/sec')) {
        scenario = line.trim();
      }
    }
  }
  return best;
}

function row(spec, best) {
  const values = COLUMNS.map((column) => {
    const name = spec.cases[column];
    if (!name) return null;
    const ns = best.get(`${spec.scenario}\t${name}`);
    if (ns === undefined) throw new Error(`no result for "${name}" in "${spec.scenario}"`);
    return ns;
  });
  const winner = Math.min(...values.filter((ns) => ns !== null));
  const cells = values.map((ns, i) => {
    const mark = spec.marks?.[COLUMNS[i]];
    if (ns === null) return mark ? `— ${mark}` : '—';
    const text = ns === winner ? `**${ops(ns)}**` : ops(ns);
    return mark ? `${text} ${mark}` : text;
  });
  return `| ${spec.label} | ${cells.join(' | ')} |`;
}

const busy = () => loadavg()[0];

let outputs;
if (from !== null) {
  outputs = [readFileSync(from, 'utf8')];
} else {
  if (write && busy() > maxLoad) {
    console.error(`bench:write: load average is ${busy().toFixed(1)}; the tables need an idle machine (under ${maxLoad}). Pass --max-load to change the limit, or --dry to run without writing.`);
    process.exit(1);
  }
  outputs = [];
  for (let pass = 1; pass <= passes; pass++) {
    console.log(`pass ${pass} of ${passes} (load ${busy().toFixed(1)})`);
    outputs.push(execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'bench/vs.ts'], { cwd: root, encoding: 'utf8' }));
  }
  if (save !== null) writeFileSync(save, outputs.join('\n'));
  if (write && busy() > maxLoad) {
    console.error(`bench:write: the load average rose to ${busy().toFixed(1)} during the run; nothing was written.`);
    process.exit(1);
  }
}

const best = fastest(outputs);
const rows = ROWS.map((spec) => ({ label: spec.label, line: row(spec, best) }));
for (const { line } of rows) console.log(line);

if (!write) process.exit(0);

const machine = `Node ${process.versions.node.split('.')[0]}, ${cpus()[0]?.model ?? 'unknown CPU'}`;
for (const file of ['README.md', 'docs/comparison.md', ...also]) {
  const path = file.startsWith('/') ? file : root + file;
  let text = readFileSync(path, 'utf8');
  for (const { label, line } of rows) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^\\| ${escaped} \\|.*$`, 'm'), line);
  }
  text = text.replace(/Node \d+, [^)\n]+\)/g, `${machine})`);
  writeFileSync(path, text);
  console.log(`  updated ${file}`);
}
