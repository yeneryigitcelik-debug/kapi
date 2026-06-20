// `kapi eval` — modelleri gömülü Türkçe görev setiyle ölç ve skor kartı bas.
import { loadConfig, indexModels } from '../core/config.js';
import { getProvider } from '../providers/index.js';
import { TASKS, KATEGORILER } from './eval-tasks.js';
import log, { bold, dim, green, yellow, red, cyan } from '../util/log.js';

function colorFor(ratio) {
  if (ratio >= 0.8) return green;
  if (ratio >= 0.5) return yellow;
  return red;
}

function bar(ratio, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

async function runModel(name, modelCfg, timeoutMs, verbose) {
  const provider = getProvider(modelCfg.provider);
  log.raw('');
  log.raw(bold(`▶ ${name} ${dim(`(${modelCfg.provider}:${modelCfg.model})`)}`));

  const results = [];
  for (const task of TASKS) {
    const t0 = Date.now();
    let content = '';
    let verdict = { pass: false, note: '' };
    let errored = false;

    try {
      const res = await provider.chat(
        modelCfg,
        {
          model: modelCfg.model,
          messages: [{ role: 'user', content: task.prompt }],
          temperature: 0,
          stream: false,
        },
        { timeoutMs }
      );
      const json = await res.json();
      content = json?.choices?.[0]?.message?.content ?? '';
      verdict = task.check(content);
    } catch (e) {
      errored = true;
      verdict = { pass: false, note: `hata: ${e?.message ?? e}` };
    }

    const ms = Date.now() - t0;
    results.push({ task, pass: verdict.pass, note: verdict.note, ms, content, errored });

    const mark = verdict.pass ? green('✓') : red('✗');
    log.raw(`  ${mark} ${dim(task.kategori.padEnd(10))} ${task.id.padEnd(22)} ${dim(verdict.note || '')}`);
    if (verbose && !verdict.pass) {
      const preview = String(content).replace(/\s+/g, ' ').trim().slice(0, 200);
      log.raw(dim(`      ↳ ${preview || '(boş yanıt)'}`));
    }
  }

  return results;
}

function scorecard(name, results) {
  log.raw('');
  log.raw(dim(`  skor kartı — ${name}`));

  for (const kat of KATEGORILER) {
    const inKat = results.filter((r) => r.task.kategori === kat);
    if (inKat.length === 0) continue;
    const passed = inKat.filter((r) => r.pass).length;
    const ratio = passed / inKat.length;
    const c = colorFor(ratio);
    log.raw(`    ${kat.padEnd(10)} ${c(bar(ratio))} ${c(`${passed}/${inKat.length}`)} ${dim(pct(ratio))}`);
  }

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const ratio = total ? passed / total : 0;
  const avgMs = total ? Math.round(results.reduce((a, r) => a + r.ms, 0) / total) : 0;
  const c = colorFor(ratio);
  log.raw('');
  log.raw(`    ${bold('toplam')}     ${c(bar(ratio))} ${c(`${passed}/${total}`)} ${c(bold(pct(ratio)))}  ${dim(`ort. ${avgMs}ms`)}`);

  return { name, passed, total, ratio, avgMs };
}

function comparison(summaries) {
  const sorted = [...summaries].sort((a, b) => b.ratio - a.ratio || a.avgMs - b.avgMs);
  const medals = ['🥇', '🥈', '🥉'];
  log.raw('');
  log.raw(bold('  karşılaştırma'));
  sorted.forEach((s, i) => {
    const medal = medals[i] || '  ';
    const c = colorFor(s.ratio);
    log.raw(`    ${medal} ${s.name.padEnd(16)} ${c(pct(s.ratio).padStart(4))} ${dim(`(${s.passed}/${s.total}, ort. ${s.avgMs}ms)`)}`);
  });
  log.raw('');
}

export async function evalCmd(args) {
  const cfg = loadConfig(args.config);
  const index = indexModels(cfg);
  const timeoutMs = cfg.routing?.timeout_ms ?? 120000;
  const verbose = args.verbose === true;

  let targets;
  if (args.model !== undefined) {
    const name = String(args.model);
    if (!index.has(name)) {
      log.error(`Bilinmeyen model: '${name}'. Tanımlılar: ${[...index.keys()].join(', ')}.`);
      process.exit(1);
    }
    targets = [name];
  } else {
    targets = [...index.keys()];
  }

  log.raw('');
  log.raw(bold(cyan('kapı eval')) + dim(` — ${TASKS.length} görev, ${targets.length} model, hakemsiz/deterministik`));

  const summaries = [];
  for (const name of targets) {
    const results = await runModel(name, index.get(name), timeoutMs, verbose);
    summaries.push(scorecard(name, results));
  }

  if (summaries.length > 1) comparison(summaries);
}
