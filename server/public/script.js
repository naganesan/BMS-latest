// public/script.js
(() => {
  // =======================
  // === DOM Elements ===
  // =======================
  const locInput = document.getElementById('locationInput');
  const locSug = document.getElementById('locSuggestions');

  const cinInput = document.getElementById('cinemaInput');
  const cinSug = document.getElementById('cinSuggestions');

  const movieInput = document.getElementById('movieInput');
  const movieSug = document.getElementById('movieSuggestions');

  const createBtn = document.getElementById('createTaskBtn');
  const enableSoundBtn = document.getElementById('enableSoundBtn');
  const stopAllAlarmsBtn = document.getElementById('stopAllAlarmsBtn');
  const tasksList = document.getElementById('tasksList');
  const formStatus = document.getElementById('formStatus');

  const alarmAudio = document.getElementById('alarmAudio');
  alarmAudio.loop = true;

  // Booking inputs
  const showIndexInput = document.getElementById('showIndexInput');
  const seatQtyInput = document.getElementById('seatQtyInput');
  const targetSeatInput = document.getElementById('targetSeatInput');
  const nextSeatsInput = document.getElementById('nextSeatsInput');
  const emailInput = document.getElementById('emailInput');
  const mobileInput = document.getElementById('mobileInput');

  // Modal
  const alarmModal = document.getElementById('alarmModal');
  const alarmModalPlay = document.getElementById('alarmModalPlay');
  const alarmModalOpen = document.getElementById('alarmModalOpen');
  const alarmModalStop = document.getElementById('alarmModalStop');
  const alarmModalTitle = document.getElementById('alarmModalTitle');
  const alarmModalText = document.getElementById('alarmModalText');

  // =======================
  // === State Variables ===
  // =======================
  let locations = [];
  let cinemasForLocation = [];
  let moviesForLocation = [];
  let selectedLocation = null;
  let selectedCinema = null;
  let selectedMovie = null;
  let selectedBookingSettings = null;
  let playingTaskId = null;

  const AUDIO_FLAG = 'bms_audio_enabled';

  // =======================
  // === Helpers ===========
  // =======================
  function setAudioEnabled(flag) {
    try { localStorage.setItem(AUDIO_FLAG, flag ? '1' : '0'); } catch(e) {}
  }

  function isAudioEnabled() {
    try { return localStorage.getItem(AUDIO_FLAG) === '1'; } catch(e){ return false; }
  }

  function showTempStatus(msg, ms=3000) {
    formStatus.innerText = msg;
    if (ms>0) setTimeout(()=> formStatus.innerText='', ms);
  }

  function populateSuggestionList(container, arr, inputEl, onPick, emptyMsg='No results') {
    container.innerHTML = '';
    if (document.activeElement !== inputEl) { container.style.display='none'; return; }
    if (!arr || arr.length === 0) {
      const n = document.createElement('div');
      n.className = 'muted';
      n.innerText = emptyMsg;
      container.appendChild(n);
      container.style.display='block';
      return;
    }
    arr.slice(0,5).forEach(it => {
      const d = document.createElement('div');
      d.className = 'item';
      d.innerText = it.name || it;
      d.onclick = () => { onPick(it); container.style.display='none'; };
      container.appendChild(d);
    });
    container.style.display='block';
  }

  // =======================
  // === Fetch Functions ===
  // =======================
  async function fetchLocations() {
    formStatus.textContent = 'Loading locations...';
    try {
      const res = await fetch('/api/locations');
      const data = await res.json();
      locations = data.locations || [];
      formStatus.textContent = '';
      return locations;
    } catch (e) {
      console.error('Failed to fetch locations:', e);
      formStatus.textContent = 'Failed to load locations';
      return [];
    }
  }

  async function fetchCinemas(location) {
    if (!location) return [];
    formStatus.textContent = 'Loading cinemas...';
    try {
      const res = await fetch(`/api/cinemas?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      cinemasForLocation = data.cinemas || [];
      formStatus.textContent = '';
      return cinemasForLocation;
    } catch (e) {
      console.error('Failed to fetch cinemas:', e);
      formStatus.textContent = 'Failed to load cinemas';
      return [];
    }
  }

  async function fetchUpcoming(location) {
    if (!location) return [];
    movieSug.innerHTML = '<div class="muted">Loading upcoming movies…</div>';
    movieSug.style.display = 'block';
    try {
      const res = await fetch(`/api/upcoming?location=${encodeURIComponent(location)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to fetch upcoming movies');
      moviesForLocation = (data.results || []).map(x => ({
        name: x.name,
        href: x.href,
        identifier: x.id || x.identifier
      }));
      return moviesForLocation;
    } catch (e) {
      console.error('Failed to fetch upcoming movies:', e);
      moviesForLocation = [];
      movieSug.innerHTML = '<div class="muted">Failed to load movies</div>';
      return [];
    }
  }

  // =======================
  // === Input Handlers ====
  // =======================
  locInput.addEventListener('focus', async () => {
    if (!locations.length) await fetchLocations();
    populateSuggestionList(locSug, locations, locInput, (loc) => {
      locInput.value = loc;
      selectedLocation = loc;
      selectedCinema = null; selectedMovie = null;
      cinInput.value = movieInput.value = '';
      cinemasForLocation = []; moviesForLocation = [];
      fetchCinemas(loc).catch(()=>{}); fetchUpcoming(loc).catch(()=>{});
    });
  });

  locInput.addEventListener('input', () => {
    const q = locInput.value.trim().toLowerCase();
    const filtered = locations.filter(l => l.toLowerCase().includes(q));
    populateSuggestionList(locSug, filtered, locInput, (loc) => {
      locInput.value = loc;
      selectedLocation = loc;
      selectedCinema = null; selectedMovie = null;
      cinInput.value = movieInput.value = '';
      cinemasForLocation = []; moviesForLocation = [];
      fetchCinemas(loc).catch(()=>{}); fetchUpcoming(loc).catch(()=>{});
    });
  });

  locInput.addEventListener('blur', () => setTimeout(()=> locSug.style.display='none', 150));

  cinInput.addEventListener('focus', async () => {
    if (!selectedLocation) { showTempStatus('Select a location first'); return; }
    await fetchCinemas(selectedLocation);
    populateSuggestionList(cinSug, cinemasForLocation, cinInput, (cin) => {
      cinInput.value = cin.name;
      selectedCinema = cin;
    }, 'No cinemas found on this location');
  });

  cinInput.addEventListener('input', () => {
    const q = cinInput.value.trim().toLowerCase();
    const filtered = cinemasForLocation.filter(c => c.name.toLowerCase().includes(q));
    populateSuggestionList(cinSug, filtered, cinInput, (c) => { cinInput.value=c.name; selectedCinema=c; });
  });

  cinInput.addEventListener('blur', () => setTimeout(()=> cinSug.style.display='none', 150));

  movieInput.addEventListener('focus', async () => {
    if (!selectedLocation) { showTempStatus('Select location first'); return; }
    await fetchUpcoming(selectedLocation);
    populateSuggestionList(movieSug, moviesForLocation, movieInput, (m) => {
      movieInput.value = m.name;
      selectedMovie = m;
    }, 'No movies found');
  });

  movieInput.addEventListener('input', () => {
    const q = movieInput.value.trim().toLowerCase();
    const filtered = moviesForLocation.filter(m => (m.name||'').toLowerCase().includes(q));
    populateSuggestionList(movieSug, filtered, movieInput, (m) => { movieInput.value=m.name; selectedMovie=m; });
  });

  movieInput.addEventListener('blur', () => setTimeout(()=> movieSug.style.display='none', 150));

  // =======================
  // === Create Task =======
  // =======================
  createBtn.addEventListener('click', async () => {
    if (!selectedLocation) { showTempStatus('Select location'); return; }
    if (!selectedCinema) { showTempStatus('Select cinema'); return; }
    if (!selectedMovie) { showTempStatus('Select movie'); return; }

    // build bookingSettings from inputs
    const show_index = showIndexInput.value ? parseInt(showIndexInput.value, 10) : null;
    const seat_quantity = seatQtyInput.value ? parseInt(seatQtyInput.value, 10) : null;
    const target_seat = (targetSeatInput.value || '').trim() || null;
    const next_seats = (nextSeatsInput.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const email = (emailInput.value || '').trim() || null;
    const mobile = (mobileInput.value || '').trim() || null;

    const bookingSettings = {
      THEATRE_URL: selectedCinema.url || selectedCinema, // theatre url = cinema url
      MOVIE_ID: selectedMovie.identifier || (selectedMovie.href ? selectedMovie.href.split('/').pop() : null),
      SHOW_INDEX: show_index,
      SEAT_QUANTITY: seat_quantity,
      TARGET_SEAT: target_seat,
      NEXT_SEATS: next_seats,
      EMAIL: email,
      MOBILE_NUMBER: mobile
    };

    const payload = {
      location: selectedLocation,
      cinemaName: selectedCinema.name,
      cinemaUrl: selectedCinema.url,
      identifier: selectedMovie.identifier || (selectedMovie.href ? selectedMovie.href.split('/').pop() : null),
      bookingSettings
    };
    if (!payload.identifier) { showTempStatus('Cannot determine movie identifier'); return; }

    createBtn.disabled = true; createBtn.innerText = 'Creating...';
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        showTempStatus('Task created');
        await loadTasks();
      } else {
        showTempStatus('Create failed: '+(data.error||'unknown'));
      }
    } catch (e) {
      console.error('Error creating task:', e);
      showTempStatus('Network error');
    } finally {
      createBtn.disabled=false; createBtn.innerText='Create Task';
    }
  });

  // =======================
  // === Load & Render Tasks
  // =======================
  async function loadTasks() {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      renderTaskList(data.tasks || []);
    } catch(e) {
      console.error('Failed to load tasks', e);
    }
  }

  function renderTaskList(tasks) {
    tasksList.innerHTML='';
    if (!tasks.length) {
      const n = document.createElement('div'); n.className='muted'; n.innerText='No active tasks';
      tasksList.appendChild(n); return;
    }

    tasks.forEach(t => {
      const el = document.createElement('div'); el.className = 'task '+(t.status==='found'?'found':'');
      const meta = document.createElement('div'); meta.className='meta';
      const title = document.createElement('div'); title.className='title';
      title.innerText = `${t.cinemaName || ''} — ${t.identifier}`;
      const sub = document.createElement('div'); sub.className='muted small';
      sub.innerText = `${t.location} — ${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}`;
      meta.appendChild(title); meta.appendChild(sub);

      // Show cinema url explicitly
      const urlLine = document.createElement('div'); urlLine.className = 'muted small';
      urlLine.innerHTML = `Cinema URL: <a href="${t.cinemaUrl}" target="_blank">${t.cinemaUrl}</a>`;
      meta.appendChild(urlLine);

      // booking summary
      if (t.bookingSettings) {
        const b = t.bookingSettings;
        const bs = document.createElement('div'); bs.className='muted tiny';
        bs.innerText = `Booking → SHOW:${b.SHOW_INDEX||'-'} QTY:${b.SEAT_QUANTITY||'-'} TARGET:${b.TARGET_SEAT||'-'} EMAIL:${b.EMAIL||'-'} MOBILE:${b.MOBILE_NUMBER||'-'}`;
        meta.appendChild(bs);
      }

      const actions = document.createElement('div'); actions.className='actions';

      if (t.status==='found') {
        const openBtn = document.createElement('button'); openBtn.className='openbtn'; openBtn.innerText='Open Found Link';
        openBtn.onclick = ()=> window.open(t.foundHref||t.href||t.cinemaUrl, '_blank');
        actions.appendChild(openBtn);

        const playBtn = document.createElement('button'); playBtn.className='openbtn'; playBtn.style.background='#ffc107'; playBtn.innerText='Play Alarm';
        playBtn.onclick = async ()=> { try { await alarmAudio.play(); playingTaskId=t.id; } catch(e){ showTempStatus('Enable Alarm first'); } };
        actions.appendChild(playBtn);
      }

      // Reload task (re-inject observer)
      const reloadBtn = document.createElement('button'); reloadBtn.className='smallbtn'; reloadBtn.style.background='#17a2b8'; reloadBtn.innerText='Reload Task';
      reloadBtn.onclick = async ()=> {
        reloadBtn.disabled = true; reloadBtn.innerText='Reloading...';
        try {
          const r = await fetch(`/api/tasks/${t.id}/reload`, { method:'POST' });
          const d = await r.json();
          if (d.ok) { await loadTasks(); showTempStatus('Task reloaded'); }
          else showTempStatus('Reload failed');
        } catch(e){ console.error(e); showTempStatus('Reload failed'); }
        reloadBtn.disabled = false; reloadBtn.innerText='Reload Task';
      };
      actions.appendChild(reloadBtn);

      const delBtn = document.createElement('button'); delBtn.className='smallbtn'; delBtn.style.background='#6c757d'; delBtn.innerText='Delete';
      delBtn.onclick = async ()=> {
        if (!confirm('Delete this task?')) return;
        try {
          const r = await fetch(`/api/tasks/${t.id}`, { method:'DELETE' });
          const d = await r.json();
          if (d.ok) { await loadTasks(); showTempStatus('Task deleted'); }
        } catch(e){ console.error(e); showTempStatus('Delete failed'); }
      };
      actions.appendChild(delBtn);

      el.appendChild(meta); el.appendChild(actions);
      tasksList.appendChild(el);
    });
  }

  // =======================
  // === Audio & Modal ====
  // =======================
  enableSoundBtn.addEventListener('click', async () => {
    try {
      await alarmAudio.play(); alarmAudio.pause(); setAudioEnabled(true);
      enableSoundBtn.innerText='Sound Enabled'; enableSoundBtn.disabled=true;
      showTempStatus('Audio enabled');
    } catch(e){ showTempStatus('Allow audio playback first'); }
  });

  // Universal stop button — stops all client-side audio and hides modal
  stopAllAlarmsBtn.addEventListener('click', () => {
    try {
      alarmAudio.pause(); alarmAudio.currentTime = 0; playingTaskId = null;
      hideAlarmModal();
      showTempStatus('All alarms stopped', 2000);
    } catch(e) { console.warn('stopAllAlarms error', e); }
  });

  function showAlarmModal(task) {
    if (!task) return;
    alarmModalTitle.innerText = 'Movie link found — ' + (task.identifier||'');
    alarmModalText.innerText = 'Click Play Alarm or Open Found Link.';
    alarmModalOpen.onclick = ()=> window.open(task.foundHref||task.href||task.cinemaUrl,'_blank');
    alarmModalPlay.onclick = async ()=> { await alarmAudio.play(); playingTaskId=task.id; alarmModal.style.display='none'; };
    alarmModalStop.onclick = ()=> { alarmAudio.pause(); alarmAudio.currentTime=0; playingTaskId=null; alarmModal.style.display='none'; };
    alarmModal.style.display='flex';
  }

  function hideAlarmModal(){ alarmModal.style.display='none'; }

  // =======================
  // === SSE Events =======
  // =======================
  const evtSource = new EventSource('/events');
  evtSource.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (!data) return;

      switch(data.type) {
        case 'found':
          // Attempt autoplay; if blocked, show modal (user can play)
          alarmAudio.play().catch(()=>showAlarmModal(data.task));
          // Update UI instantly with the task payload
          loadTasks(); break;
        case 'stopped': case 'deleted': case 'taskCreated': case 'taskStarted': case 'resumed': case 'reloading':
          loadTasks(); break;
        case 'taskError':
          showTempStatus('Task error: '+(data.message||'unknown'),5000); break;
        default:
          // other events ignored or log for debugging
          // console.log('SSE event:', data);
          break;
      }
    } catch(err){ console.error('SSE parse error', err); }
  };

  // =======================
  // === Initialization ====
  // =======================
  (async function init(){
    await fetchLocations();
    if (isAudioEnabled()) {
      try { await alarmAudio.play(); alarmAudio.pause(); enableSoundBtn.innerText='Sound Enabled'; enableSoundBtn.disabled=true; } catch(e){}
    }
    await loadTasks();
    // keep tasks list fresh — SSE will trigger loads on events; a short interval ensures UI stays in sync
    setInterval(()=> loadTasks(), 2000);
  })();

})();
