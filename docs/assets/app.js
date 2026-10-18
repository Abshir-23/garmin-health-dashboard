/* Health dashboard: reads CSV files written by garmin_dashboard.fetch.
 * Looks for your own data in ./data/ first (git-ignored), then falls back to ./sample/.
 * All values are written with textContent, never innerHTML, so CSV content can't inject markup.
 */
(function () {
  'use strict';

  const FILES = ['sleep', 'daily', 'intensity', 'status'];
  const parseDate = d3.utcParse('%Y-%m-%d');
  const fmtDate = (s) => d3.utcFormat('%b %-d')(parseDate(s));
  const fmtInt = d3.format(',');
  const mean = (a) => (a.length ? d3.mean(a) : NaN);
  const num = (v) => (v === '' || v == null ? NaN : Number(v));
  const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h + m / 60 + (h < 18 ? 24 : 0); };
  const hmLabel = (v) => String(Math.floor(v) % 24).padStart(2, '0') + ':' + String(Math.round((v % 1) * 60)).padStart(2, '0');
  const dur = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)} h ${m % 60} min`; };
  const C = ['var(--c1)', 'var(--c2)', 'var(--c3)'];
  const $ = (id) => document.getElementById(id);

  // ---------- loading ----------
  async function loadSet(base) {
    const out = {};
    for (const name of FILES) {
      const res = await fetch(`${base}/${name}.csv`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${base}/${name}.csv: ${res.status}`);
      // d3.csvParse builds objects with new Function(), which the strict CSP blocks,
      // so parse rows and map them to objects by hand.
      const [header, ...rows] = d3.csvParseRows(await res.text());
      out[name] = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
    }
    return out;
  }

  async function load() {
    try { return { data: await loadSet('data'), sample: false }; }
    catch (e) { return { data: await loadSet('sample'), sample: true }; }
  }

  // ---------- summary ----------
  function summarise(data) {
    const sleep = data.sleep.map((r) => ({
      date: r.date, hours: num(r.sleep_hours), score: num(r.sleep_score), deep: num(r.deep_hours),
      light: num(r.light_hours), rem: num(r.rem_hours), hrv: num(r.hrv_ms), bed: r.bedtime, wake: r.wake_time,
    })).sort((a, b) => d3.ascending(a.date, b.date));
    const daily = data.daily.map((r) => ({
      date: r.date, steps: num(r.steps), kcal: num(r.active_kcal), rhr: num(r.resting_hr), stress: num(r.stress_avg),
    })).sort((a, b) => d3.ascending(a.date, b.date));
    const intensity = data.intensity.map((r) => ({
      week: r.week_start, moderate: num(r.moderate_min), vigorous: num(r.vigorous_min), total: num(r.total_min), goal: num(r.goal_min) || 150,
    })).sort((a, b) => d3.ascending(a.week, b.week));
    const status = Object.fromEntries(data.status.map((r) => [r.metric, r.value]));

    const timed = sleep.filter((r) => r.bed && r.wake);
    const byWake = [...timed].sort((a, b) => hm(a.wake) - hm(b.wake));
    const byBed = [...timed].sort((a, b) => hm(a.bed) - hm(b.bed));
    const hrv = sleep.filter((r) => !isNaN(r.hrv));
    const first7 = daily.slice(0, 7), last7 = daily.slice(-7);
    const rhrDaily = mean(daily.map((r) => r.rhr).filter((v) => !isNaN(v)));

    return {
      sleep, daily, intensity, status,
      first: sleep[0]?.date || daily[0]?.date, last: daily.at(-1)?.date || sleep.at(-1)?.date,
      sleepHours: mean(sleep.map((r) => r.hours)),
      sleepScore: mean(sleep.map((r) => r.score).filter((v) => !isNaN(v))),
      badNights: sleep.filter((r) => r.score < 70).length,
      hrvAvg: mean(hrv.map((r) => r.hrv)),
      hrvFirst: mean(hrv.slice(0, 7).map((r) => r.hrv)), hrvLast: mean(hrv.slice(-7).map((r) => r.hrv)),
      wakeEarly: byWake[0]?.wake, wakeLate: byWake.at(-1)?.wake,
      wakeSpread: byWake.length ? hm(byWake.at(-1).wake) - hm(byWake[0].wake) : 0,
      bedEarly: byBed[0]?.bed, bedLate: byBed.at(-1)?.bed,
      steps: mean(daily.map((r) => r.steps)),
      stepsFirst: mean(first7.map((r) => r.steps)), stepsLast: mean(last7.map((r) => r.steps)),
      stress: mean(daily.map((r) => r.stress).filter((v) => !isNaN(v))),
      intensityAvg: mean(intensity.map((r) => r.total)),
      intensityGoal: intensity.at(-1)?.goal || 150,
      rhr: num(status.resting_hr) || rhrDaily,
    };
  }

  // ---------- text helpers ----------
  /** Build a paragraph from parts: strings become text, {b: x} becomes bold text. */
  function para(cls, parts) {
    const p = document.createElement('p');
    if (cls) p.className = cls;
    for (const part of parts) {
      if (part == null || part === false) continue;
      if (typeof part === 'object') { const b = document.createElement('b'); b.textContent = part.b; p.append(b); }
      else p.append(document.createTextNode(part));
    }
    return p;
  }
  const setText = (id, t) => { $(id).textContent = t; };

  // ---------- recommendations ----------
  function recommendations(s, isSample) {
    const recs = [];
    const status = s.status.training_status;
    if (s.intensityAvg < s.intensityGoal * 0.6) {
      recs.push({
        p: 1, title: 'Get your heart rate up 2–3 times a week',
        why: ['You average ', { b: Math.round(s.intensityAvg) }, ' intensity minutes a week against a goal of ', { b: s.intensityGoal }, '.',
          status ? ' Garmin says ' : null, status ? { b: status } : null, status ? '.' : null],
        todo: "Start an activity on the watch every time you train, including strength and martial arts, or Garmin won't count it. Add two runs or interval sessions a week.",
      });
    }
    if (s.wakeSpread > 2) {
      recs.push({
        p: 2, title: 'Keep a steadier sleep schedule',
        why: ['You woke up anywhere from ', { b: s.wakeEarly }, ' to ', { b: s.wakeLate }, ' and fell asleep between ', { b: s.bedEarly }, ' and ', { b: s.bedLate }, '.'],
        todo: 'Try to get up within the same hour most days, as far as work allows. A steady wake time often helps more than sleeping longer.',
      });
    }
    if (s.sleepHours < 7) {
      recs.push({
        p: 2, title: 'Sleep a little more',
        why: ['You sleep ', { b: dur(s.sleepHours) }, ' a night on average. Most adults need 7–9 hours.'],
        todo: 'Move bedtime 30 minutes earlier and keep screens out of the last half hour.',
      });
    }
    if (s.stepsLast < s.stepsFirst * 0.9 || s.steps < 8000) {
      recs.push({
        p: 3, title: 'Move more during the day',
        why: ['Daily steps went from ', { b: fmtInt(Math.round(s.stepsFirst)) }, ' in the first week to ', { b: fmtInt(Math.round(s.stepsLast)) }, ' in the last.'],
        todo: 'Aim for 8,000–10,000 steps. A 20–30 minute walk on desk days is enough.',
      });
    }
    if (s.hrvLast < s.hrvFirst * 0.9) {
      recs.push({
        p: 2, title: 'Prioritise recovery',
        why: ['Overnight HRV fell from ', { b: Math.round(s.hrvFirst) }, ' ms to ', { b: Math.round(s.hrvLast) }, ' ms over the period.'],
        todo: 'Take an easier week, keep alcohol and late meals down, and protect your sleep.',
      });
    }
    const daysOld = s.last ? (Date.now() - parseDate(s.last)) / 864e5 : 0;
    if (!isSample && daysOld > 3) {
      recs.push({
        p: 4, title: 'Sync your watch',
        why: ['The newest data is from ', { b: fmtDate(s.last) }, '. Everything after that is missing.'],
        todo: 'Sync in Garmin Connect, then run the fetch script again.',
      });
    }
    return recs.sort((a, b) => a.p - b.p).slice(0, 4);
  }

  function goingWell(s) {
    const out = [];
    const fa = num(s.status.fitness_age), age = num(s.status.chronological_age);
    if (fa && age && fa < age) out.push(['Fitness age ', { b: fa }, ', while you are ', { b: age }]);
    if (s.rhr && s.rhr < 60) out.push(['Resting heart rate of ', { b: Math.round(s.rhr) }]);
    if (s.sleepScore >= 80) out.push(['Average sleep score of ', { b: Math.round(s.sleepScore) }, ', with ', { b: s.badNights }, s.badNights === 1 ? ' night' : ' nights', ' below 70']);
    if (s.stress < 25) out.push(['Low stress, ', { b: Math.round(s.stress) }, ' on average']);
    if (s.hrvAvg && s.hrvLast >= s.hrvFirst * 0.9) out.push(['Steady HRV around ', { b: Math.round(s.hrvAvg) }, ' ms']);
    return out;
  }

  // ---------- chart helpers ----------
  const M = { r: 10, t: 12, b: 26 };

  function tip(el, ev, head, lines) {
    const box = el.parentNode, t = box.querySelector('.tip');
    t.replaceChildren();
    const h = document.createElement('div'); h.className = 'tip-h'; h.textContent = head; t.append(h);
    for (const [color, label, value] of lines) {
      const r = document.createElement('div'); r.className = 'tip-r';
      if (color) { const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = color; r.append(sw); }
      const a = document.createElement('span'); a.textContent = label;
      const b = document.createElement('b'); b.textContent = value;
      r.append(a, b); t.append(r);
    }
    t.hidden = false;
    const bb = box.getBoundingClientRect();
    let x = ev.clientX - bb.left + 14;
    if (x + t.offsetWidth > bb.width) x = ev.clientX - bb.left - t.offsetWidth - 14;
    t.style.left = Math.max(0, x) + 'px';
    t.style.top = Math.max(0, ev.clientY - bb.top + 14) + 'px';
  }
  const hideTip = (el) => { el.parentNode.querySelector('.tip').hidden = true; };

  function frame(el, H, y, fmt, ticks) {
    el.replaceChildren();
    const W = Math.max(260, el.clientWidth);
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('height', H).attr('viewBox', `0 0 ${W} ${H}`);
    const axis = () => { const a = d3.axisLeft(y).tickFormat(fmt); return Array.isArray(ticks) ? a.tickValues(ticks) : a.ticks(ticks); };
    const probe = svg.append('g').attr('class', 'axis').call(axis()).attr('font-size', null).attr('font-family', null);
    let widest = 0;
    probe.selectAll('text').each(function () { widest = Math.max(widest, this.getComputedTextLength()); });
    probe.remove();
    const m = { ...M, l: Math.ceil(widest) + 12 };
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`)
      .call(axis().tickSize(-(W - m.l - m.r)).tickPadding(8)).attr('font-size', null).attr('font-family', null)
      .select('.domain').remove();
    return { svg, W, m };
  }

  function xAxis(svg, x, H, m, minGap = 54) {
    const dom = x.domain();
    const every = Math.max(1, Math.ceil((dom.length * minGap) / (x.range()[1] - x.range()[0])));
    svg.append('g').attr('class', 'axis axis-x').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(dom.filter((d, i) => (dom.length - 1 - i) % every === 0)).tickFormat(fmtDate).tickSize(0).tickPadding(9))
      .attr('font-size', null).attr('font-family', null);
  }

  function refLine(svg, y, v, m, W, label) {
    svg.append('line').attr('class', 'ref').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v));
    svg.append('text').attr('class', 'ref-t').attr('x', W - m.r).attr('y', y(v) - 5).attr('text-anchor', 'end').text(label);
  }

  function hover(svg, el, x, rows, key, H, m, onMove, onLeave) {
    svg.append('g').selectAll('rect').data(rows).join('rect')
      .attr('x', (r) => x(r[key]) - (x.step() - x.bandwidth()) / 2).attr('width', x.step())
      .attr('y', m.t).attr('height', H - m.t - m.b).style('fill', 'transparent')
      .on('mousemove', onMove).on('mouseleave', () => { hideTip(el); if (onLeave) onLeave(); });
  }

  // ---------- charts ----------
  function sleepChart(s) {
    const el = $('c-sleep'), rows = s.sleep, H = 240;
    const keys = [['deep', 'Deep'], ['rem', 'REM'], ['light', 'Light']];
    const leg = $('leg-sleep'); leg.replaceChildren();
    keys.forEach(([, name], i) => { const sp = document.createElement('span'); const sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = C[i]; sp.append(sw, name); leg.append(sp); });
    const y = d3.scaleLinear([0, Math.max(10, d3.max(rows, (r) => r.deep + r.rem + r.light) || 0)], [H - M.b, M.t]).nice();
    const { svg, W, m } = frame(el, H, y, (v) => `${v} h`, 5);
    const x = d3.scaleBand(rows.map((r) => r.date), [m.l, W - m.r]).padding(0.28);
    svg.append('g').selectAll('g').data(d3.stack().keys(keys.map((k) => k[0]))(rows)).join('g').style('fill', (d, i) => C[i])
      .selectAll('rect').data((d) => d).join('rect')
      .attr('x', (p) => x(p.data.date)).attr('width', x.bandwidth()).attr('rx', 2)
      .attr('y', (p) => y(p[1])).attr('height', (p) => Math.max(0, y(p[0]) - y(p[1]) - 1));
    refLine(svg, y, 7, m, W, '7 h');
    xAxis(svg, x, H, m);
    hover(svg, el, x, rows, 'date', H, m, (ev, r) => tip(el, ev, fmtDate(r.date), [
      [null, 'Sleep score', String(r.score)], [null, 'Total', dur(r.hours)],
      [C[0], 'Deep', dur(r.deep)], [C[1], 'REM', dur(r.rem)], [C[2], 'Light', dur(r.light)],
      [null, 'Asleep–awake', `${r.bed}–${r.wake}`]]));
  }

  function scheduleChart(s) {
    const el = $('c-schedule'), H = 240;
    const rows = s.sleep.filter((r) => r.bed && r.wake).map((r) => ({ ...r, a: hm(r.bed), z: hm(r.wake) }));
    const lo = Math.floor(d3.min(rows, (r) => r.a)), hi = Math.ceil(d3.max(rows, (r) => r.z));
    const y = d3.scaleLinear([lo, hi], [M.t, H - M.b]);
    const { svg, W, m } = frame(el, H, y, hmLabel, d3.range(Math.ceil(lo / 2) * 2, hi + 0.01, 2));
    const x = d3.scaleBand(rows.map((r) => r.date), [m.l, W - m.r]).padding(0.35);
    svg.append('g').selectAll('rect').data(rows).join('rect')
      .attr('x', (r) => x(r.date)).attr('width', x.bandwidth()).attr('rx', 4)
      .attr('y', (r) => y(r.a)).attr('height', (r) => Math.max(2, y(r.z) - y(r.a))).style('fill', C[0]);
    xAxis(svg, x, H, m);
    hover(svg, el, x, rows, 'date', H, m, (ev, r) => tip(el, ev, `Night to ${fmtDate(r.date)}`, [
      [null, 'Fell asleep', r.bed], [null, 'Woke up', r.wake], [null, 'Sleep', dur(r.hours)]]));
  }

  function lineChart(id, rows, { domain, ref, refLabel, head, lines }) {
    const el = $(id), H = 200;
    if (!rows.length) { el.replaceChildren(para('empty', ['No data for this period.'])); return; }
    const y = d3.scaleLinear(domain(rows), [H - M.b, M.t]).nice();
    const { svg, W, m } = frame(el, H, y, (v) => v, 4);
    const x = d3.scaleBand(rows.map((r) => r.k), [m.l, W - m.r]).padding(0.3);
    const cx = (r) => x(r.k) + x.bandwidth() / 2;
    if (ref != null) refLine(svg, y, ref, m, W, refLabel);
    svg.append('path').datum(rows).style('fill', 'none').style('stroke', C[0]).attr('stroke-width', 2)
      .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round').attr('d', d3.line().x(cx).y((r) => y(r.v)));
    const dots = svg.append('g').selectAll('circle').data(rows).join('circle').attr('cx', cx).attr('cy', (r) => y(r.v)).attr('r', 3).style('fill', C[0]);
    xAxis(svg, x, H, m);
    hover(svg, el, x, rows, 'k', H, m, (ev, r) => { dots.attr('r', (o) => (o === r ? 5 : 3)); tip(el, ev, head(r), lines(r)); }, () => dots.attr('r', 3));
  }

  function barChart(id, rows, { min, fmt, ref, refLabel, gap, head, lines }) {
    const el = $(id), H = 240;
    const y = d3.scaleLinear([0, Math.max(min, d3.max(rows, (r) => r.v) || 0)], [H - M.b, M.t]).nice();
    const { svg, W, m } = frame(el, H, y, fmt, 5);
    const x = d3.scaleBand(rows.map((r) => r.k), [m.l, W - m.r]).padding(0.25);
    const bw = Math.min(32, x.bandwidth());
    const bars = svg.append('g').selectAll('rect').data(rows).join('rect')
      .attr('x', (r) => x(r.k) + (x.bandwidth() - bw) / 2).attr('width', bw).attr('rx', Math.min(4, bw / 2))
      .attr('y', (r) => y(r.v)).attr('height', (r) => Math.max(0, y(0) - y(r.v))).style('fill', C[0]);
    refLine(svg, y, ref, m, W, refLabel);
    xAxis(svg, x, H, m, gap);
    hover(svg, el, x, rows, 'k', H, m, (ev, r) => { bars.attr('opacity', (o) => (o === r ? 1 : 0.55)); tip(el, ev, head(r), lines(r)); }, () => bars.attr('opacity', 1));
  }

  // ---------- render ----------
  function render(s, isSample) {
    const range = s.first && s.last ? `${fmtDate(s.first)} – ${fmtDate(s.last)}` : '';
    const lede = $('lede');
    lede.replaceWith(para('lede', [
      isSample ? 'Demo with generated sample data. ' : null,
      range ? 'Covering ' : null, range ? { b: range } : null, range ? '. ' : null,
      'Sleep score averages ', { b: Math.round(s.sleepScore) }, ', while intensity minutes average ', { b: Math.round(s.intensityAvg) },
      ' a week against a goal of ', { b: s.intensityGoal }, '.',
    ]));
    document.querySelector('.lede').id = 'lede';
    const badge = $('source');
    badge.hidden = false;
    badge.textContent = isSample ? 'Sample data' : 'Your data';

    setText('k-score', Math.round(s.sleepScore));
    setText('k-sleep', dur(s.sleepHours));
    setText('k-hrv', isNaN(s.hrvAvg) ? '—' : Math.round(s.hrvAvg));
    setText('k-rhr', isNaN(s.rhr) ? '—' : Math.round(s.rhr));
    setText('k-int', Math.round(s.intensityAvg));
    setText('k-int-sub', `average minutes, goal ${s.intensityGoal}`);
    $('k-int').classList.toggle('bad', s.intensityAvg < s.intensityGoal * 0.6);
    setText('k-steps', fmtInt(Math.round(s.steps)));

    const list = $('focus-list'); list.replaceChildren();
    const recs = recommendations(s, isSample);
    if (!recs.length) list.append(para('empty', ['Nothing stands out. Keep doing what you are doing.']));
    recs.forEach((r, i) => {
      const li = document.createElement('li');
      const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
      const h = document.createElement('h3'); h.textContent = r.title;
      li.append(n, h, para('why', r.why), para('', [r.todo]));
      list.append(li);
    });

    const good = $('good-list'); good.replaceChildren();
    goingWell(s).forEach((parts) => { const li = document.createElement('li'); li.append(...para('', parts).childNodes); good.append(li); });

    const tbody = document.querySelector('#t-race tbody'); tbody.replaceChildren();
    [['5 km', 'race_5k'], ['10 km', 'race_10k'], ['Half marathon', 'race_half'], ['Marathon', 'race_marathon']].forEach(([label, key]) => {
      if (!s.status[key]) return;
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = label;
      const b = document.createElement('td'); b.textContent = s.status[key];
      tr.append(a, b); tbody.append(tr);
    });

    drawCharts(s);
  }

  function drawCharts(s) {
    sleepChart(s);
    scheduleChart(s);
    lineChart('c-hrv', s.sleep.filter((r) => !isNaN(r.hrv)).map((r) => ({ k: r.date, v: r.hrv, score: r.score })), {
      domain: (rows) => [Math.min(80, d3.min(rows, (r) => r.v) - 5), d3.max(rows, (r) => r.v) + 5],
      head: (r) => fmtDate(r.k), lines: (r) => [[null, 'HRV', `${r.v} ms`], [null, 'Sleep score', String(r.score)]],
    });
    lineChart('c-stress', s.daily.filter((r) => !isNaN(r.stress)).map((r) => ({ k: r.date, v: r.stress })), {
      domain: (rows) => [0, Math.max(40, d3.max(rows, (r) => r.v))], ref: 25, refLabel: 'Rest below 25',
      head: (r) => fmtDate(r.k), lines: (r) => [[null, 'Stress', String(r.v)]],
    });
    barChart('c-int', s.intensity.map((r) => ({ k: r.week, v: r.total, ...r })), {
      min: s.intensityGoal + 10, fmt: (v) => `${v} min`, ref: s.intensityGoal, refLabel: `Goal ${s.intensityGoal}`, gap: 50,
      head: (r) => `Week of ${fmtDate(r.k)}`,
      lines: (r) => [[null, 'Moderate', `${r.moderate} min`], [null, 'Vigorous', `${r.vigorous} min`], [null, 'Total', `${r.v} min`]],
    });
    barChart('c-steps', s.daily.map((r) => ({ k: r.date, v: r.steps, kcal: r.kcal })), {
      min: 10000, fmt: fmtInt, ref: 10000, refLabel: '10,000', gap: 54,
      head: (r) => fmtDate(r.k), lines: (r) => [[null, 'Steps', fmtInt(r.v)], [null, 'Active calories', fmtInt(r.kcal)]],
    });
  }

  load().then(({ data, sample }) => {
    const s = summarise(data);
    render(s, sample);
    let last = window.innerWidth;
    new ResizeObserver(() => { if (window.innerWidth !== last) { last = window.innerWidth; drawCharts(s); } }).observe(document.body);
  }).catch((err) => {
    const lede = $('lede');
    lede.className = 'lede error';
    lede.textContent = `Could not load data: ${err.message}. Serve the docs folder over HTTP, for example: python -m http.server -d docs 8000`;
  });
})();
