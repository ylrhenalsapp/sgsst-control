/**
 * Recorrido guiado (tour) por las secciones del sitio: se ofrece la primera
 * vez que se usa el panel en este navegador (con una pantalla de bienvenida)
 * y se puede volver a ver en cualquier momento desde el botón "🎓 Tutorial"
 * de la barra superior. No borra ni modifica ningún dato — solo guía por la
 * interfaz ya existente con tooltips que resaltan cada parte de la pantalla.
 */
const TOUR_SEEN_KEY = 'sgsst_tour_seen_v1';

const TOUR_STEPS = [
  { nav: null, target: '.filters', title: '1. Filtros principales', text: 'Aquí eliges la Empresa, la Sede y el Mes que quieres ver. Todo el panel se actualiza según esta selección.' },
  { nav: '#dashboard', target: '.grid4', title: '2. Resumen del mes', text: 'Estas tarjetas muestran las horas asignadas, ejecutadas, disponibles y el valor ejecutado del periodo seleccionado.' },
  { nav: '#dashboard', target: '#dashboardActivities', title: '3. Actividades de la sede', text: 'Aquí ves el estado de cada actividad. Si una ya está "Completada" puedes usar su botón "✏️ Editar horas" para corregirla, siempre que el mes de ese registro no esté cerrado.' },
  { nav: '#actividades', target: '#activitiesList', title: '4. Gestión de actividades', text: 'Vista detallada del avance de cada actividad de la sede seleccionada.' },
  { nav: '#horas', target: '#hoursTable', title: '5. Registro de horas', text: 'Aquí quedan todos los registros de horas, día a día. Puedes editarlos o eliminarlos mientras el mes siga abierto.' },
  { nav: '#horas', target: '#monthCloseBanner', title: '6. Cierre mensual', text: 'Cuando termines de distribuir las horas del mes, ciérralo manualmente aquí. Un mes cerrado ya no admite ediciones ni horas nuevas, pero puedes reabrirlo si necesitas corregir algo.' },
  { nav: '#evidencias', target: '#evidencias .tablewrap', title: '7. Evidencias y links', text: 'Sube un archivo o registra un enlace (Drive, OneDrive, SharePoint...) como soporte de cada actividad realizada.' },
  { nav: '#calendario', target: '.calendarToolbar', title: '8. Calendario', text: 'Programa actividades con cada empresa y valida tu disponibilidad. Si un cliente cancela, puedes reprogramar el evento o eliminarlo directamente desde el detalle de la cita.' },
  { nav: '#informes', target: '#informes .panelhead', title: '9. Informes', text: 'Genera el informe mensual o global de una sede y expórtalo en PDF, Word, o prepáralo para enviarlo por correo.' },
  { nav: '#configuracion', target: '.tabs', title: '10. Configuración', text: 'Administra empresas, sedes, bolsas de horas mensuales, catálogo de actividades y la tarifa por hora. Desde "Sedes y horas" puedes editar en cualquier momento qué actividades tiene cada sede y sus horas asignadas del mes.' },
  { nav: null, target: '.notifWrap', title: '11. Notificaciones', text: 'La campana te avisa cuando hay actividades pendientes o próximas a vencer.' },
];

let tourIndex = 0;

// Se llama una vez terminó de cargar el panel tras iniciar sesión. Muestra la
// bienvenida solo la primera vez en este navegador (no borra ni toca datos).
function maybeShowWelcomeTour() {
  try {
    if (localStorage.getItem(TOUR_SEEN_KEY)) return;
    localStorage.setItem(TOUR_SEEN_KEY, '1');
  } catch (e) {
    return; // si el navegador bloquea localStorage, simplemente no se fuerza el tour
  }
  openModal('welcomeModal');
}

function startTour() {
  closeModal('welcomeModal');
  tourIndex = 0;
  tourShowStep(0);
}

function tourEnd() {
  $('tourSpotlight').style.display = 'none';
  $('tourTooltip').style.display = 'none';
}

function tourSkip() { tourEnd(); }

function tourShowStep(i) {
  const step = TOUR_STEPS[i];
  if (!step) return tourEnd();
  tourIndex = i;
  if (step.nav) {
    const link = document.querySelector(`.nav a[href="${step.nav}"]`);
    if (link && !link.classList.contains('active')) showSection(step.nav.slice(1), link);
  }
  // Pequeña espera para que el DOM de la sección recién activada se pinte
  // antes de medir la posición del elemento a resaltar.
  setTimeout(() => tourPositionStep(step), 60);
}

function tourPositionStep(step) {
  const target = step.target ? document.querySelector(step.target) : null;
  const tooltip = $('tourTooltip'), spotlight = $('tourSpotlight');
  $('tourStepLabel').textContent = `Paso ${tourIndex + 1} de ${TOUR_STEPS.length}`;
  $('tourTitleText').textContent = step.title;
  $('tourText').textContent = step.text;
  $('tourPrevBtn').style.display = tourIndex > 0 ? 'inline-block' : 'none';
  $('tourNextBtn').textContent = tourIndex === TOUR_STEPS.length - 1 ? 'Finalizar' : 'Siguiente';

  if (target) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      const r = target.getBoundingClientRect();
      const pad = 8;
      spotlight.style.display = 'block';
      spotlight.style.top = Math.max(0, r.top - pad) + 'px';
      spotlight.style.left = Math.max(0, r.left - pad) + 'px';
      spotlight.style.width = (r.width + pad * 2) + 'px';
      spotlight.style.height = (r.height + pad * 2) + 'px';

      tooltip.style.transform = 'none';
      tooltip.style.display = 'block';
      const spaceBelow = window.innerHeight - r.bottom;
      const top = spaceBelow > 220 ? Math.min(window.innerHeight - 220, r.bottom + pad + 10) : Math.max(10, r.top - pad - 210);
      const left = Math.min(window.innerWidth - 340, Math.max(10, r.left));
      tooltip.style.top = top + 'px';
      tooltip.style.left = left + 'px';
    }, 260); // esperar a que termine el scrollIntoView suave
  } else {
    spotlight.style.display = 'none';
    tooltip.style.display = 'block';
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translate(-50%,-50%)';
  }
}

function tourNext() { tourIndex < TOUR_STEPS.length - 1 ? tourShowStep(tourIndex + 1) : tourEnd(); }
function tourPrev() { if (tourIndex > 0) tourShowStep(tourIndex - 1); }

window.addEventListener('resize', () => {
  if ($('tourTooltip') && $('tourTooltip').style.display === 'block' && TOUR_STEPS[tourIndex]) tourPositionStep(TOUR_STEPS[tourIndex]);
});
