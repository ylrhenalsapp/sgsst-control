/**
 * Informes: generación en pantalla (igual que antes) + exportación real a
 * PDF (jsPDF) y Excel (SheetJS), además del envío por correo (mailto).
 */
let lastReport = null;

function generateReport() {
  const c = company(), s = site(), m = $('reportMonth')?.value || selectedMonth(), scope = $('reportScope')?.value || 'monthly';
  const monthly = state.hoursSite.filter(x => x.site_id === s.id && monthOf(x.record_date) === m);
  const all = state.hoursSite.filter(x => x.site_id === s.id);
  const rows = scope === 'global' ? all : monthly;
  const used = rows.reduce((a, x) => a + Number(x.hours), 0), executed = rows.reduce((a, x) => a + Number(x.hours) * Number(x.rate), 0);
  const monthValue = monthly.reduce((a, x) => a + Number(x.hours) * Number(x.rate), 0);
  const bag = state.bag, pendingValue = bag.remaining * Number(state.rate || 0);
  const ev = state.evidencesSite.filter(x => scope === 'global' || monthOf(x.record_date) === m);
  const acts = state.activities.map(t => {
    const st = taskStatus(s.id, t.id), hrs = scope === 'global' ? taskHours(s.id, t.id) : taskMonthHours(s.id, t.id, m);
    return { name: t.name, status: st, hours: hrs };
  });
  const title = scope === 'global' ? 'Informe global consolidado SG-SST' : 'Informe mensual de seguimiento SG-SST';

  $('reportBox').innerHTML = `<h2 style="margin-top:0">${title}</h2><p><b>Empresa:</b> ${c.name}<br><b>Sede:</b> ${s.name}<br><b>Mes de referencia:</b> ${m}${scope === 'global' ? '<br><span class="small">El consolidado incluye todos los registros históricos de la sede.</span>' : ''}</p>
  <div class="kpirow">
  <div class="kpi"><span class="small">Cantidad de horas ${scope === 'global' ? 'totales' : 'del mes'}</span><b>${used} h</b></div>
  <div class="kpi"><span class="small">Valor ejecutado</span><b>${money(executed)}</b></div>
  <div class="kpi"><span class="small">Valor pendiente</span><b>${money(pendingValue)}</b><span class="small">Saldo vigente de ${bag.remaining} h en ${m}</span></div>
  <div class="kpi"><span class="small">Valor del mes</span><b>${money(monthValue)}</b></div>
  </div>
  <div class="kpirow" style="margin-top:12px"><div class="kpi"><span class="small">Bolsa del mes</span><b>${bag.total} h</b><span class="small">Asignadas ${bag.assigned} · Saldo ${bag.carry} · Adicionales ${bag.additional}</span></div><div class="kpi"><span class="small">Horas ejecutadas en ${m}</span><b>${bag.used} h</b></div><div class="kpi"><span class="small">Saldo a favor para siguiente mes</span><b>${bag.remaining} h</b></div></div>
  <h3>Actividades</h3><ol>${acts.map(a => `<li><b>${a.name}</b> — ${a.status} · ${a.hours} h registradas</li>`).join('')}</ol><h3>Evidencias registradas</h3><p>${ev.length} evidencia(s) incluidas en el informe.</p>
  <h3>Regla operativa de la bolsa</h3><p>Las horas asignadas normalmente se registran durante los primeros 5 días del mes. Si quedan horas sin ejecutar, el saldo se traslada automáticamente al siguiente mes como saldo a favor. Las ampliaciones quedan registradas como adicionales del mes correspondiente.</p>`;
  toast('Informe generado');
  lastReport = { c, s, m, scope, used, executed, monthValue, pendingValue, ev, bag, acts, rows, title };
  return lastReport;
}

function prepareEmail() {
  const r = lastReport || generateReport();
  const subject = encodeURIComponent(`Informe ${r.scope === 'global' ? 'global' : 'mensual'} SG-SST – ${r.s.name} – ${r.m}`);
  const body = encodeURIComponent(`Cordial saludo,\n\nCompartimos el informe ${r.scope === 'global' ? 'global consolidado' : 'mensual'} de seguimiento para ${r.c.name}, sede ${r.s.name}.\n\nHoras: ${r.used} h\nValor ejecutado: ${money(r.executed)}\nValor pendiente de bolsa vigente: ${money(r.pendingValue)}\nValor del mes ${r.m}: ${money(r.monthValue)}\n\nCordialmente,`);
  window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

function exportReportPDF() {
  const r = lastReport || generateReport();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(14); doc.text(r.title, 14, 16);
  doc.setFontSize(10);
  doc.text(`Empresa: ${r.c.name}`, 14, 26);
  doc.text(`Sede: ${r.s.name}`, 14, 32);
  doc.text(`Mes de referencia: ${r.m}`, 14, 38);
  doc.autoTable({
    startY: 44,
    head: [['Indicador', 'Valor']],
    body: [
      ['Horas', `${r.used} h`],
      ['Valor ejecutado', money(r.executed)],
      ['Valor pendiente (saldo bolsa)', money(r.pendingValue)],
      ['Valor del mes', money(r.monthValue)],
      ['Bolsa del mes (total)', `${r.bag.total} h`],
      ['Saldo a favor siguiente mes', `${r.bag.remaining} h`],
    ],
  });
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 10,
    head: [['Actividad', 'Estado', 'Horas']],
    body: r.acts.map(a => [a.name, a.status, a.hours]),
  });
  doc.save(`informe-sgsst-${r.s.name.replace(/\s+/g, '_')}-${r.m}.pdf`);
}

function exportReportExcel() {
  const r = lastReport || generateReport();
  const wb = XLSX.utils.book_new();
  const summary = [
    ['Informe', r.title],
    ['Empresa', r.c.name],
    ['Sede', r.s.name],
    ['Mes de referencia', r.m],
    [],
    ['Indicador', 'Valor'],
    ['Horas', r.used],
    ['Valor ejecutado', r.executed],
    ['Valor pendiente', r.pendingValue],
    ['Valor del mes', r.monthValue],
    ['Bolsa del mes (total)', r.bag.total],
    ['Saldo a favor siguiente mes', r.bag.remaining],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Resumen');
  const actRows = [['Actividad', 'Estado', 'Horas']].concat(r.acts.map(a => [a.name, a.status, a.hours]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(actRows), 'Actividades');
  const detailRows = [['Fecha', 'Actividad', 'Horas', 'Tarifa', 'Valor', 'Estado']].concat(
    r.rows.map(x => [x.record_date, taskName(x.activity_id), x.hours, x.rate, x.hours * x.rate, x.status])
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detailRows), 'Detalle de horas');
  XLSX.writeFile(wb, `informe-sgsst-${r.s.name.replace(/\s+/g, '_')}-${r.m}.xlsx`);
}
