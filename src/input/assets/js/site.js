(() => {
  const menu = document.querySelector('.menu-toggle');
  const nav = document.querySelector('#primary-nav');
  if (menu && nav) {
    const close = () => { menu.setAttribute('aria-expanded', 'false'); nav.classList.remove('is-open'); };
    menu.addEventListener('click', () => {
      const expanded = menu.getAttribute('aria-expanded') === 'true';
      menu.setAttribute('aria-expanded', String(!expanded));
      nav.classList.toggle('is-open', !expanded);
    });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }
  const search = document.querySelector('#post-search');
  const cards = [...document.querySelectorAll('.list-article')];
  const filters = [...document.querySelectorAll('[data-filter]')];
  if (!search || !cards.length) return;
  let category = new URLSearchParams(location.search).get('category') || 'all';
  if (!filters.some(f => f.dataset.filter === category)) category = 'all';
  function update() {
    const query = search.value.trim().toLocaleLowerCase();
    let count = 0;
    cards.forEach(card => {
      const visible = (category === 'all' || card.dataset.category === category) && card.textContent.toLocaleLowerCase().includes(query);
      card.hidden = !visible;
      if (visible) count++;
    });
    filters.forEach(filter => {
      const active = filter.dataset.filter === category;
      filter.classList.toggle('active', active);
      filter.setAttribute('aria-pressed', String(active));
    });
    document.querySelector('#result-count').textContent = `${count} article${count === 1 ? '' : 's'}`;
    document.querySelector('#no-results').hidden = count !== 0;
  }
  search.addEventListener('input', update);
  filters.forEach(filter => filter.addEventListener('click', () => {
    category = filter.dataset.filter;
    const url = new URL(location.href);
    if (category === 'all') url.searchParams.delete('category');
    else url.searchParams.set('category', category);
    history.replaceState(null, '', url);
    update();
  }));
  update();
})();
