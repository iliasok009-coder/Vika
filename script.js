'use strict';

const $ = id => document.getElementById(id);
const state = {
  movies: [], sessions: [], adminSessions: [], adminBookings: [],
  config: { seatCount: 40, rows: 5, seatsPerRow: 8, timeZone: 'Asia/Qyzylorda' },
  selected: new Set(), occupied: new Set(), seatsReady: false,
  seatRequest: 0, catalogueRequest: 0, occupancyRequest: 0,
  isAdmin: false, busy: false, pending: null, adminOccupancyId: null
};

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
  } catch {
    throw new ApiError('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.', 0);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError('Сервер вернул неверный ответ. Попробуйте ещё раз.', response.status); }
  if (!response.ok) throw new ApiError(data.error || 'Не удалось выполнить действие.', response.status);
  return data;
}

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function notice(id, text = '', type = '') {
  const target = $(id);
  target.textContent = text;
  target.className = `notice ${type}`;
  target.hidden = !text;
}
function money(value) { return new Intl.NumberFormat('ru-RU').format(Number(value) || 0); }
function dateLabel(value, long = false) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value || '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: long ? 'long' : 'short', ...(long ? { year: 'numeric' } : {}), timeZone: 'UTC'
  }).format(date);
}
function cinemaToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: state.config.timeZone }).format(new Date());
}
function currentSession() { return state.sessions.find(s => s.id === Number($('session').value)); }
function currentMovie() { return state.movies.find(m => m.id === Number($('movieSelect').value)); }
function seatLabel(seat) {
  return `ряд ${Math.ceil(seat / state.config.seatsPerRow)}, место ${(seat - 1) % state.config.seatsPerRow + 1} (№${seat})`;
}
function seatList(seats) { return [...seats].sort((a, b) => a - b).join(', '); }
function option(value, text) { const item = node('option', '', text); item.value = String(value); return item; }
function empty(container, text) { container.replaceChildren(node('p', 'empty-state', text)); }
function actionButton(text, action, id, className = 'secondary') {
  const button = node('button', className, text);
  button.type = 'button'; button.dataset.action = action; button.dataset.id = id;
  return button;
}

async function loadCatalogue({ preserve = true } = {}) {
  const request = ++state.catalogueRequest;
  const previousMovie = preserve ? $('movieSelect').value : '';
  const previousSession = preserve ? $('session').value : '';
  $('retryLoad').hidden = true;
  try {
    const [movies, sessions] = await Promise.all([api('/api/movies'), api('/api/sessions')]);
    if (request !== state.catalogueRequest) return;
    state.movies = movies;
    state.sessions = sessions;
    renderMovies();
    $('movieSelect').replaceChildren(...movies.map(m => option(m.id, m.title)));
    $('movieSelect').disabled = movies.length === 0 || state.busy;
    if (movies.some(m => String(m.id) === previousMovie)) $('movieSelect').value = previousMovie;
    if (!movies.length) $('movieSelect').append(option('', 'Пока нет фильмов'));
    renderSessionOptions(previousSession);
    populateAdminMovies();
    await loadSeats();
    notice('pageMessage');
  } catch (error) {
    if (request !== state.catalogueRequest) return;
    state.seatsReady = false;
    $('movieSelect').disabled = true;
    $('session').disabled = true;
    state.selected.clear();
    updateSummary();
    notice('pageMessage', error.message || 'Не удалось загрузить афишу. Проверьте подключение.', 'error');
    $('retryLoad').hidden = false;
    $('seatStatus').textContent = 'Расписание недоступно. Повторите загрузку.';
  }
}

function renderMovies() {
  const list = $('movieList');
  list.replaceChildren();
  $('catalogueCount').textContent = `${state.movies.length} фильмов · ${state.sessions.length} предстоящих сеансов`;
  if (!state.movies.length) {
    empty(list, 'Афиша пока пуста. Администратор может добавить фильмы и сеансы.');
    return;
  }
  state.movies.forEach((movie, index) => {
    const card = node('article', 'movie');
    const poster = node('div', `poster poster-${index % 5}`);
    poster.setAttribute('aria-hidden', 'true');
    poster.append(node('span', 'poster-number', `CINEMA / ${String(index + 1).padStart(2, '0')}`));
    poster.append(node('span', 'poster-title', movie.title));
    if (movie.age_rating) poster.append(node('span', 'age-badge', movie.age_rating));
    const content = node('div', 'movie-content');
    content.append(node('p', 'movie-meta', [movie.genre, `${movie.duration} мин.`, movie.year, movie.age_rating].filter(Boolean).join(' · ')));
    content.append(node('h3', '', movie.title));
    content.append(node('p', 'movie-description', movie.description || 'Описание фильма скоро появится.'));
    if (movie.director) content.append(node('p', 'movie-credits', `Режиссёр: ${movie.director}`));
    const upcoming = state.sessions.filter(s => s.movie_id === movie.id);
    const chips = node('div', 'session-chips');
    upcoming.slice(0, 4).forEach(session => {
      const button = node('button', 'session-chip');
      button.type = 'button'; button.dataset.session = session.id;
      button.append(node('span', '', `${session.time} · ${money(session.price)} ₸`));
      button.append(node('small', '', `${dateLabel(session.date)} · свободно ${session.free_seats ?? state.config.seatCount}`));
      button.setAttribute('aria-label', `${movie.title}, ${dateLabel(session.date, true)}, ${session.time}, ${money(session.price)} тенге`);
      button.addEventListener('click', () => chooseMovie(movie.id, session.id));
      chips.append(button);
    });
    content.append(chips);
    if (!upcoming.length) content.append(node('p', 'muted', 'Новых сеансов пока нет. Следите за афишей.'));
    const choose = node('button', 'movie-more', upcoming.length ? `Все сеансы (${upcoming.length}) →` : 'Посмотреть фильм →');
    choose.type = 'button'; choose.addEventListener('click', () => chooseMovie(movie.id));
    content.append(choose);
    card.append(poster, content); list.append(card);
  });
}
function renderSessionOptions(preferred = '') {
  const sessions = state.sessions.filter(s => s.movie_id === Number($('movieSelect').value));
  $('session').replaceChildren(...sessions.map(s => option(s.id, `${dateLabel(s.date)}, ${s.time} · ${money(s.price)} ₸ · ${s.free_seats ?? state.config.seatCount} своб.`)));
  $('session').disabled = !sessions.length || state.busy;
  if (!sessions.length) $('session').append(option('', 'Нет доступных сеансов'));
  else if (sessions.some(s => String(s.id) === String(preferred))) $('session').value = String(preferred);
}
async function chooseMovie(movieId, sessionId) {
  if (state.busy) return;
  $('movieSelect').value = String(movieId);
  renderSessionOptions(sessionId);
  notice('message');
  await loadSeats();
  $('booking').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSeatMap(container, occupied, interactive = false) {
  const focusedNumber = interactive && container.contains(document.activeElement) ? document.activeElement.dataset.seat : null;
  const fragment = document.createDocumentFragment();
  for (let row = 1; row <= state.config.rows; row++) {
    const label = node('span', 'row-label', row);
    label.setAttribute('aria-label', `Ряд ${row}`); fragment.append(label);
    for (let column = 1; column <= state.config.seatsPerRow; column++) {
      const number = (row - 1) * state.config.seatsPerRow + column;
      if (number > state.config.seatCount) continue;
      const isOccupied = occupied.has(number);
      const seat = node(interactive ? 'button' : 'span', `seat${isOccupied ? ' occupied' : ''}${interactive && state.selected.has(number) ? ' selected' : ''}`, number);
      seat.dataset.seat = String(number);
      seat.title = `${seatLabel(number)} — ${isOccupied ? 'занято' : 'свободно'}`;
      seat.setAttribute('aria-label', seat.title);
      if (interactive) {
        seat.type = 'button'; seat.disabled = isOccupied || state.busy;
        seat.setAttribute('aria-pressed', String(state.selected.has(number)));
        seat.addEventListener('click', () => {
          if (state.busy || !state.seatsReady || isOccupied) return;
          if (state.selected.has(number)) state.selected.delete(number);
          else state.selected.add(number);
          seat.classList.toggle('selected', state.selected.has(number));
          seat.setAttribute('aria-pressed', String(state.selected.has(number)));
          notice('message'); updateSummary();
        });
      }
      fragment.append(seat);
    }
  }
  container.replaceChildren(fragment);
  if (focusedNumber) {
    const previous = container.querySelector(`button[data-seat="${focusedNumber}"]`);
    const next = previous && !previous.disabled ? previous : container.querySelector('button[data-seat]:not(:disabled)');
    if (next) next.focus({ preventScroll: true });
    else { $('seatStatus').tabIndex = -1; $('seatStatus').focus({ preventScroll: true }); }
  }
}
async function loadSeats({ preserve = false, silent = false } = {}) {
  const request = ++state.seatRequest;
  const session = currentSession();
  if (!preserve) state.selected.clear();
  if (!silent) state.seatsReady = false;
  if (!silent) { $('seats').replaceChildren(); $('seatStatus').textContent = session ? 'Проверяем свободные места…' : 'Нет доступных сеансов для этого фильма.'; }
  updateSummary();
  if (!session) return;
  try {
    const occupied = await api(`/api/occupied/${session.id}`);
    if (request !== state.seatRequest || currentSession()?.id !== session.id) return;
    const occupancyChanged = occupied.length !== state.occupied.size || occupied.some(number => !state.occupied.has(number));
    state.occupied = new Set(occupied);
    let dropped = false;
    for (const number of state.selected) {
      if (state.occupied.has(number)) { state.selected.delete(number); dropped = true; }
    }
    state.seatsReady = true;
    session.free_seats = state.config.seatCount - state.occupied.size;
    if (!silent || occupancyChanged || !$('seats').querySelector('button[data-seat]')) renderSeatMap($('seats'), state.occupied, true);
    $('seatStatus').textContent = `Зал 1 · Свободно ${session.free_seats} из ${state.config.seatCount} мест`;
    if (dropped) notice('message', 'Часть выбранных мест уже занята. Выберите другие места.', 'error');
    updateSummary();
  } catch (error) {
    if (request !== state.seatRequest) return;
    state.seatsReady = false;
    $('seats').replaceChildren();
    $('seatStatus').textContent = 'Не удалось проверить места.';
    notice('message', `${error.message} Нажмите «Обновить места».`, 'error');
    const retry = actionButton('Обновить места', 'retry-seats', '');
    retry.addEventListener('click', () => loadSeats({ preserve: true }));
    $('seats').append(retry);
    updateSummary();
  }
}
function updateSummary() {
  const session = currentSession();
  const movie = currentMovie();
  $('summaryMovie').textContent = movie?.title || 'Выберите фильм';
  $('summarySession').textContent = session ? `${dateLabel(session.date, true)} · ${session.time} · Зал 1` : 'Нет доступного сеанса';
  $('sessionInfo').textContent = movie ? `${movie.genre} · ${movie.duration} мин.${movie.age_rating ? ` · ${movie.age_rating}` : ''}` : 'Выберите фильм из афиши.';
  $('summarySeats').textContent = state.selected.size ? `№ ${seatList(state.selected)}` : 'Ещё не выбраны';
  $('count').textContent = state.selected.size;
  $('summaryPrice').textContent = session ? `${money(session.price)} ₸` : '—';
  $('total').textContent = money(state.selected.size * (session?.price || 0));
  $('bookBtn').disabled = state.busy || !state.seatsReady || !session || !state.selected.size;
}
function orderDetails(data) {
  const wrapper = node('div');
  wrapper.append(node('h3', '', data.movie_title));
  wrapper.append(node('p', 'muted', `${dateLabel(data.date, true)} · ${data.time} · Зал 1`));
  const details = node('dl', 'order-details');
  for (const [label, value] of [['Имя', data.customerName], ['Места', `№ ${seatList(data.seats)}`], ['Билетов', data.seats.length], ['За билет', `${money(data.price)} ₸`]]) {
    const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); details.append(row);
  }
  wrapper.append(details);
  const total = node('div', 'total-line'); total.append(node('span', '', 'Итого'), node('strong', '', `${money(data.total)} ₸`)); wrapper.append(total);
  return wrapper;
}
function reviewBooking(event) {
  event.preventDefault();
  if (state.busy || !$('bookingForm').reportValidity()) return;
  const session = currentSession();
  const customerName = $('customerName').value.trim();
  if (customerName.length < 2) { notice('message', 'Введите имя от 2 до 100 символов.', 'error'); $('customerName').focus(); return; }
  if (!session || !state.seatsReady || !state.selected.size) { notice('message', 'Выберите сеанс и хотя бы одно свободное место.', 'error'); return; }
  state.pending = { sessionId: session.id, customerName, seats: [...state.selected].sort((a, b) => a - b), movie_title: session.movie_title, date: session.date, time: session.time, price: session.price, total: state.selected.size * session.price };
  $('confirmDetails').replaceChildren(orderDetails(state.pending));
  notice('confirmMessage'); $('confirmDialog').showModal();
}
function setBookingBusy(busy) {
  state.busy = busy;
  $('confirmBooking').disabled = busy; $('cancelBooking').disabled = busy;
  $('confirmBooking').textContent = busy ? 'Бронируем…' : 'Подтвердить бронь';
  $('customerName').disabled = busy;
  $('movieSelect').disabled = busy || !state.movies.length;
  $('session').disabled = busy || !currentSession();
  $('seats').querySelectorAll('button[data-seat]').forEach(button => { button.disabled = busy || state.occupied.has(Number(button.dataset.seat)); });
  updateSummary();
}
async function submitBooking() {
  if (state.busy || !state.pending) return;
  const pending = state.pending;
  setBookingBusy(true); notice('confirmMessage');
  try {
    const result = await api('/api/bookings', { method: 'POST', body: JSON.stringify({ sessionId: pending.sessionId, customerName: pending.customerName, seats: pending.seats }) });
    $('confirmDialog').close(); state.pending = null; state.selected.clear();
    renderReceipt({ ...pending, ...result });
    const priceChanged = result.total !== pending.total;
    notice('message', priceChanged ? `Бронирование оформлено. Цена сеанса была обновлена: итоговая стоимость ${money(result.total)} ₸. Проверьте подтверждение ниже.` : 'Бронирование успешно оформлено. Детали — в подтверждении ниже.', priceChanged ? '' : 'success');
    await loadCatalogue();
    if (state.isAdmin) await refreshAdmin();
  } catch (error) {
    if (error.status === 409 || error.status === 404) {
      $('confirmDialog').close(); state.pending = null; state.selected.clear();
      await loadCatalogue();
      notice('message', `${error.message} Расписание и места обновлены. Проверьте выбор и повторите бронирование.`, 'error');
    } else notice('confirmMessage', error.message || 'Ошибка соединения. Не удалось подтвердить результат. Проверьте связь перед повтором.', 'error');
  } finally { setBookingBusy(false); }
}
function renderReceipt(data) {
  const receipt = $('bookingReceipt');
  receipt.replaceChildren(node('p', 'eyebrow', 'БРОНИРОВАНИЕ ПОДТВЕРЖДЕНО'), node('h3', '', 'До встречи в кино!'), node('p', 'receipt-number', `НОМЕР БРОНИ · ${data.id}`));
  const details = node('dl', 'receipt-details');
  for (const [label, value] of [['Фильм', data.movie_title], ['Сеанс', `${dateLabel(data.date, true)} · ${data.time}`], ['Имя', data.customerName], ['Места', `№ ${seatList(data.seats)}`], ['Ряд и место', data.seats.map(seatLabel).join('; ')], ['Стоимость', `${money(data.total)} ₸`]]) {
    const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); details.append(row);
  }
  receipt.append(details, node('p', 'fine-print', 'Назовите номер брони в кассе кинотеатра для оплаты и получения билетов. Бронирование сохранено в базе данных.'));
  const print = node('button', 'secondary', 'Распечатать подтверждение'); print.type = 'button'; print.addEventListener('click', () => window.print()); receipt.append(print);
  receipt.hidden = false; receipt.focus(); receipt.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setAdmin(authenticated) {
  state.isAdmin = authenticated;
  $('adminLogin').hidden = authenticated; $('adminDashboard').hidden = !authenticated;
  if (!authenticated) {
    state.adminSessions = []; state.adminBookings = []; state.adminOccupancyId = null;
    $('adminBookings').replaceChildren(); $('adminMovies').replaceChildren(); $('adminSessions').replaceChildren();
    $('adminOccupancy').hidden = true; $('adminPasswordInput').value = '';
  }
}
async function checkAdmin() {
  try { await api('/api/admin/check'); setAdmin(true); await refreshAdmin(); }
  catch (error) { setAdmin(false); if (error.status !== 401) notice('adminMessage', error.message, 'error'); }
}
async function openAdmin() {
  $('adminPanel').hidden = false; $('adminOpenBtn').setAttribute('aria-expanded', 'true');
  await checkAdmin();
  $('adminPanel').scrollIntoView({ behavior: 'smooth' });
  if (!state.isAdmin) $('adminLoginInput').focus({ preventScroll: true });
}
function adminFailure(error) {
  if (error.status === 401) { setAdmin(false); notice('adminMessage', 'Сеанс администратора завершён. Войдите снова.', 'error'); }
  else notice('adminMessage', error.message || 'Не удалось выполнить действие.', 'error');
}
async function loginAdmin(event) {
  event.preventDefault();
  const button = $('adminLoginBtn'); button.disabled = true; notice('adminMessage');
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ login: $('adminLoginInput').value.trim(), password: $('adminPasswordInput').value }) });
    $('adminPasswordInput').value = ''; setAdmin(true);
    await refreshAdmin(); notice('adminMessage', 'Вход выполнен. Панель администратора доступна.', 'success');
  } catch (error) { notice('adminMessage', error.message || 'Не удалось войти.', 'error'); }
  finally { button.disabled = false; }
}
async function logoutAdmin() {
  try { await api('/api/admin/logout', { method: 'POST' }); setAdmin(false); notice('adminMessage', 'Вы вышли из системы.', 'success'); }
  catch (error) { adminFailure(error); }
}
function switchAdminTab(name) {
  for (const tab of ['bookings', 'movies', 'sessions']) $('adminTab-' + tab).hidden = tab !== name;
  document.querySelectorAll('[data-tab]').forEach(button => { const active = button.dataset.tab === name; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}
function populateAdminMovies() {
  const previous = $('sessionMovie').value;
  $('sessionMovie').replaceChildren(...state.movies.map(movie => option(movie.id, movie.title)));
  if (state.movies.some(movie => String(movie.id) === previous)) $('sessionMovie').value = previous;
  if (!state.movies.length) $('sessionMovie').append(option('', 'Сначала добавьте фильм'));
  $('sessionSubmit').disabled = !state.movies.length;
  if (state.isAdmin) renderAdminMovies();
}
function renderAdminMovies() {
  const container = $('adminMovies'); container.replaceChildren();
  if (!state.movies.length) return empty(container, 'Фильмов пока нет. Добавьте первый фильм.');
  state.movies.forEach(movie => {
    const card = node('article', 'admin-card');
    card.append(node('h4', '', movie.title), node('p', '', [movie.genre, `${movie.duration} мин.`, movie.year, movie.age_rating].filter(Boolean).join(' · ')));
    card.append(node('p', '', movie.description || 'Без описания'));
    const actions = node('div', 'button-row'); actions.append(actionButton('Удалить фильм', 'delete-movie', movie.id, 'danger')); card.append(actions); container.append(card);
  });
}
async function refreshAdmin() {
  if (!state.isAdmin) return;
  try {
    const [sessions, bookings] = await Promise.all([api('/api/sessions?all=1'), api('/api/bookings')]);
    if (!state.isAdmin) return;
    state.adminSessions = sessions; state.adminBookings = bookings;
    const editingId = Number($('sessionForm').elements.id.value);
    if (editingId && !sessions.some(session => session.id === editingId)) resetSessionForm();
    renderAdminMovies(); renderAdminSessions(); renderAdminBookings();
    if (state.adminOccupancyId) await showOccupancy(state.adminOccupancyId);
  } catch (error) { adminFailure(error); }
}
function renderAdminBookings() {
  const container = $('adminBookings'); container.replaceChildren();
  if (!state.adminBookings.length) return empty(container, 'Бронирований пока нет.');
  state.adminBookings.forEach(booking => {
    const card = node('article', 'admin-card');
    card.append(node('h4', '', `№${booking.id} · ${booking.movie_title}`));
    card.append(node('p', '', `${dateLabel(booking.date, true)} · ${booking.time} · ${booking.customer_name}`));
    card.append(node('p', '', `Места: № ${seatList(booking.seats)} · ${booking.seats.length} бил. · ${money(booking.total)} ₸`));
    const actions = node('div', 'button-row');
    actions.append(actionButton('Отменить бронь', 'delete-booking', booking.id, 'danger'));
    card.append(actions); container.append(card);
  });
}
function renderAdminSessions() {
  const container = $('adminSessions'); container.replaceChildren();
  if (!state.adminSessions.length) return empty(container, 'Сеансов пока нет. Создайте расписание слева.');
  state.adminSessions.forEach(session => {
    const past = session.is_past === true || session.available === false && session.date < cinemaToday();
    const card = node('article', `admin-card${past ? ' session-past' : ''}`);
    const heading = node('h4', '', session.movie_title);
    if (past) heading.append(node('span', 'status-badge', 'Завершён'));
    card.append(heading, node('p', '', `${dateLabel(session.date, true)} · ${session.time} · ${money(session.price)} ₸`));
    card.append(node('p', 'free-count', `Свободно: ${session.free_seats} / ${state.config.seatCount} · Занято: ${session.occupied_seats ?? state.config.seatCount - session.free_seats}`));
    const actions = node('div', 'button-row');
    actions.append(actionButton('Места', 'view-seats', session.id), actionButton('Изменить', 'edit-session', session.id), actionButton('Удалить', 'delete-session', session.id, 'danger'));
    card.append(actions); container.append(card);
  });
}
async function showOccupancy(sessionId) {
  const request = ++state.occupancyRequest;
  const session = state.adminSessions.find(s => s.id === Number(sessionId));
  if (!session) { state.adminOccupancyId = null; $('adminOccupancy').hidden = true; return; }
  state.adminOccupancyId = session.id;
  $('adminOccupancy').hidden = false;
  $('occupancyTitle').textContent = `${session.movie_title} · ${dateLabel(session.date)} · ${session.time}`;
  $('occupancyInfo').textContent = 'Проверяем состояние зала…'; $('adminSeats').replaceChildren();
  try {
    const occupied = await api(`/api/occupied/${session.id}`);
    if (request !== state.occupancyRequest || !state.isAdmin) return;
    renderSeatMap($('adminSeats'), new Set(occupied));
    $('occupancyInfo').textContent = `Свободно ${state.config.seatCount - occupied.length} из ${state.config.seatCount} · Занятые места: ${occupied.length ? seatList(occupied) : 'нет'}`;
  } catch (error) { if (request === state.occupancyRequest) { $('occupancyInfo').textContent = 'Не удалось загрузить места. Нажмите «Места», чтобы повторить.'; adminFailure(error); } }
}
function resetSessionForm() {
  $('sessionForm').reset(); $('sessionForm').elements.id.value = '';
  $('sessionDate').value = cinemaToday();
  $('sessionFormTitle').textContent = 'Добавить сеанс'; $('sessionSubmit').textContent = 'Добавить сеанс'; $('cancelSessionEdit').hidden = true;
}
function editSession(id) {
  const session = state.adminSessions.find(s => s.id === Number(id));
  if (!session) return;
  const form = $('sessionForm');
  for (const name of ['movie_id', 'date', 'time', 'price', 'id']) form.elements[name].value = session[name];
  $('sessionFormTitle').textContent = `Изменить сеанс №${session.id}`; $('sessionSubmit').textContent = 'Сохранить изменения'; $('cancelSessionEdit').hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' }); form.elements.date.focus({ preventScroll: true });
}
async function saveMovie(event) {
  event.preventDefault();
  const form = $('movieForm'); if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  values.title = values.title.trim(); values.genre = values.genre.trim(); values.description = values.description.trim(); values.director = values.director.trim();
  values.duration = Number(values.duration); values.year = values.year ? Number(values.year) : null;
  if (!values.title || !values.genre || values.description.length < 10) { notice('adminMessage', 'Заполните название, жанр и описание фильма (от 10 символов).', 'error'); return; }
  await adminMutation(form.querySelector('[type=submit]'), async () => {
    await api('/api/movies', { method: 'POST', body: JSON.stringify(values) }); form.reset();
    await loadCatalogue(); await refreshAdmin(); notice('adminMessage', 'Фильм успешно добавлен. Теперь можно создать сеансы.', 'success');
  });
}
async function saveSession(event) {
  event.preventDefault();
  const form = $('sessionForm'); if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form)); const id = values.id;
  const body = { movie_id: Number(values.movie_id), date: values.date, time: values.time, price: Number(values.price) };
  await adminMutation($('sessionSubmit'), async () => {
    await api(`/api/sessions${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    resetSessionForm(); await loadCatalogue(); await refreshAdmin();
    notice('adminMessage', id ? 'Изменения сеанса сохранены.' : 'Сеанс добавлен в расписание.', 'success');
  });
}
async function adminMutation(button, callback) {
  if (button.disabled) return;
  button.disabled = true; notice('adminMessage');
  try { await callback(); }
  catch (error) { adminFailure(error); }
  finally { if (button.isConnected) button.disabled = false; }
}
async function adminAction(event) {
  const button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
  const id = Number(button.dataset.id); const action = button.dataset.action;
  if (action === 'view-seats') { await showOccupancy(id); $('adminOccupancy').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (action === 'edit-session') { editSession(id); return; }
  const prompts = {
    'delete-booking': `Отменить бронирование №${id}? Места снова станут свободными.`,
    'delete-movie': 'Удалить фильм и его сеансы без бронирований? Фильм с бронированиями удалить нельзя.',
    'delete-session': 'Удалить этот сеанс? Сеанс с бронированиями удалить нельзя.'
  };
  if (!prompts[action] || !window.confirm(prompts[action])) return;
  await adminMutation(button, async () => {
    const path = action === 'delete-booking' ? 'bookings' : action === 'delete-movie' ? 'movies' : 'sessions';
    await api(`/api/${path}/${id}`, { method: 'DELETE' });
    if (action === 'delete-session' && $('sessionForm').elements.id.value === String(id)) resetSessionForm();
    await loadCatalogue(); await refreshAdmin();
    notice('adminMessage', action === 'delete-booking' ? 'Бронирование отменено. Места снова доступны.' : action === 'delete-movie' ? 'Фильм и его свободные сеансы удалены.' : 'Сеанс удалён из расписания.', 'success');
  });
}

$('movieSelect').addEventListener('change', async () => { notice('message'); renderSessionOptions(); await loadSeats(); });
$('session').addEventListener('change', async () => { notice('message'); await loadSeats(); });
$('bookingForm').addEventListener('submit', reviewBooking);
$('confirmBooking').addEventListener('click', submitBooking);
$('cancelBooking').addEventListener('click', () => { if (!state.busy) { state.pending = null; $('confirmDialog').close(); } });
$('confirmDialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); else state.pending = null; });
$('retryLoad').addEventListener('click', () => loadCatalogue());
$('adminOpenBtn').addEventListener('click', openAdmin);
$('adminCloseBtn').addEventListener('click', () => { $('adminPanel').hidden = true; $('adminOpenBtn').setAttribute('aria-expanded', 'false'); $('adminOpenBtn').focus(); });
$('adminLogin').addEventListener('submit', loginAdmin);
$('adminLogoutBtn').addEventListener('click', logoutAdmin);
$('adminDashboard').addEventListener('click', adminAction);
$('showBookingsBtn').addEventListener('click', refreshAdmin);
$('refreshAdminSessions').addEventListener('click', refreshAdmin);
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchAdminTab(button.dataset.tab)));
$('movieForm').addEventListener('submit', saveMovie);
$('sessionForm').addEventListener('submit', saveSession);
$('cancelSessionEdit').addEventListener('click', resetSessionForm);

async function init() {
  try {
    const config = await api('/api/config');
    state.config = { ...state.config, ...config };
    const offset = new Intl.DateTimeFormat('ru-RU', {
      timeZone: state.config.timeZone, timeZoneName: 'shortOffset'
    }).formatToParts(new Date(config.serverNow || Date.now())).find(part => part.type === 'timeZoneName')?.value;
    $('cinemaZone').textContent = `Время кинотеатра: ${state.config.timeZone}${offset ? ` (${offset})` : ''}`;
  } catch {
    // The hall defaults match this single-screen cinema; catalogue errors remain visible below.
  }
  $('sessionDate').min = cinemaToday();
  $('movieForm').elements.year.max = String(Number(cinemaToday().slice(0, 4)) + 5);
  resetSessionForm();
  await loadCatalogue();
}
init();
setInterval(() => {
  if (!document.hidden && !state.busy && !$('confirmDialog').open && currentSession()) loadSeats({ preserve: true, silent: true });
}, 15000);
