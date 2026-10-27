/* =====================================================================
   HOME HUB — Food (schema 4): this week's dinners and the shopping list
   #/food, and #/food/<YYYY-MM-DD> for that day's dinner. A placeholder so
   the site loads with the page's tab, address and styles in place; the
   page itself (docs/v1.2-kitchen.md §6.1) replaces it, and will provide
   openListAdd() for the Add sheet's Shopping choice (§6.3). The
   shopping list's aisles, grouping and outbox are in assets/shoplist.js
   (window.HomeShop), shared with My day.
   ===================================================================== */
(function () {
  'use strict';

  const HomeHub = window.HomeHub;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  HomeHub.register({
    name: 'food',
    schema: { min: 4, max: 99 },
    nav: { label: 'Food', order: 35, primary: true },
    // #/food · #/food/<YYYY-MM-DD> (that day's dinner).
    match(parts) {
      if (parts[0] !== 'food' || parts.length > 2) return null;
      if (parts.length === 2 && !ISO_DATE.test(parts[1])) return null;
      return { day: parts[1] || null };
    },
    render(main) {
      main.innerHTML = `
        <div class="page-head food-head"><div><h1>Food</h1><p class="meta">Dinners and the shopping list</p></div></div>
        <div class="card empty-state"><p>The Food page is on its way. Reload the page to get the latest version.</p></div>`;
    },
  });
})();
