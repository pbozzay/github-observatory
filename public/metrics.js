// Only observed values are charted. Unknown is never coerced to zero.
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fmt = value => finite(value) ? new Intl.NumberFormat().format(value) : '';
export const observed = metric => metric && (finite(metric.value) || metric.points?.some(p => finite(p.value)));
export const keys = repo => Object.keys(repo.metrics || {}).filter(k => observed(repo.metrics[k]));
export function githubURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function aligned(metric, dates) {
  const points = new Map((metric.points || []).map(p => [p.date, p.value]));
  return dates.map(date => ({date, value: finite(points.get(date)) ? points.get(date) : null}));
}
// A fixed cohort prevents a changing contributor set from inventing movement.
// Event totals require identical observed-day masks; balance totals require the
// same latest observation date. Detail exposes the selected cohort and coverage.
export function aggregate(repos, key, dates) {
  const groups = new Map();
  for (const repo of repos) {
    const m = repo.metrics?.[key];
    if (!observed(m) || !finite(m.value)) continue;
    const points = aligned(m, dates);
    const known = points.filter(p => finite(p.value));
    if (!known.length) continue;
    const mask = m.kind === 'event' ? known.map(p => p.date).join(',') : known.at(-1).date;
    const signature = JSON.stringify([m.kind, m.unit, mask, m.coverage?.start, m.coverage?.end]);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push({repo, metric:m, points});
  }
  const cohort = [...groups.values()].sort((a,b) => b.length-a.length || b[0].points.filter(p=>finite(p.value)).length-a[0].points.filter(p=>finite(p.value)).length)[0];
  if (!cohort) return null;
  const first = cohort[0].metric;
  const points = dates.map((date,i) => ({date, value:cohort.every(x => finite(x.points[i].value)) ? cohort.reduce((sum,x)=>sum+x.points[i].value,0) : null}));
  return {...first, value:cohort.reduce((s,x)=>s+x.metric.value,0), delta:cohort.every(x=>finite(x.metric.delta) && x.metric.coverage?.complete) ? cohort.reduce((s,x)=>s+x.metric.delta,0) : null,
    points, coverage:{start:points.find(p=>finite(p.value))?.date ?? null,end:points.findLast(p=>finite(p.value))?.date ?? null,complete:cohort.every(x=>x.metric.coverage?.complete)}, contributors:cohort.map(x=>x.repo), lastSuccess:cohort.map(x=>x.metric.lastSuccess).filter(Boolean).sort()[0] ?? null};
}
export function chart(points, {small=false}={}) {
  const w=small?180:390, h=small?38:180, left=small?4:42, right=w-8, top=small?4:12, bottom=h-(small?4:26);
  const known=points.filter(p=>finite(p.value));
  if (!known.length) return '';
  const max=Math.max(1,...known.map(p=>p.value)), min=Math.min(0,...known.map(p=>p.value));
  const coords=points.map((p,i)=>finite(p.value)?{...p,x:points.length===1?(left+right)/2:left+i*(right-left)/(points.length-1),y:bottom-(p.value-min)/(max-min)*(bottom-top)}:null);
  const segments=[]; let current=[];
  for(const p of coords){if(p)current.push(p);else if(current.length){segments.push(current);current=[];}}
  if(current.length)segments.push(current);
  const paths=segments.map(segment=>segment.length===1?`<circle class="chart-dot" cx="${segment[0].x}" cy="${segment[0].y}" r="3"><title>${escapeHTML(segment[0].date)}: ${fmt(segment[0].value)}</title></circle>`:`<path class="chart-line" d="${segment.map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' ')}"/>`).join('');
  const hits=small?'':coords.filter(Boolean).map(p=>`<circle class="chart-hit" cx="${p.x}" cy="${p.y}" r="5"><title>${escapeHTML(p.date)}: ${fmt(p.value)}</title></circle>`).join('');
  const axes=small?'':`<line class="chart-grid" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/><text class="chart-axis" x="0" y="16">${fmt(max)}</text><text class="chart-axis" x="0" y="${bottom}">${fmt(min)}</text><text class="chart-axis" x="${left}" y="${h-4}">${escapeHTML(points[0]?.date)}</text><text class="chart-axis" text-anchor="end" x="${right}" y="${h-4}">${escapeHTML(points.at(-1)?.date)}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${axes}${paths}${hits}</svg>`;
}
export function csvCell(value) {
  let text=String(value ?? '');
  if(typeof value !== 'number' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function exportCSV(repos,range) {
  const rows=[['repository','metric','value','unit','range','coverage_start','coverage_end','coverage_complete','last_success']];
  for(const r of repos)for(const key of keys(r)){const m=r.metrics[key];rows.push([r.owner+'/'+r.name,m.label,m.value,m.unit,range,m.coverage?.start,m.coverage?.end,m.coverage?.complete,m.lastSuccess]);}
  return rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
