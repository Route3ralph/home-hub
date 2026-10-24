/* =====================================================================
   KITCHEN RENOVATION — SCHEDULE DATA
   This is the only file you need to edit to update the chart.
   ---------------------------------------------------------------------
   HOW TO EDIT ON GITHUB
     1. Open this file on github.com and click the pencil icon (Edit).
     2. Change dates, statuses or notes. Keep the commas and 'quotes'.
     3. Click "Commit changes". The live site updates in a minute or two.

   HOW THE DATES WORK
     • Tasks are scheduled automatically from `after` (what must finish
       first) and `days` (how long the work takes). Change one thing and
       everything downstream moves with it.
     • `days` counts WORKING days: Mon–Fri, skipping `holidays`.
     • `weeks` counts calendar weeks. Use it for supplier lead times,
       permits and fabrication, which run regardless of weekends.
     • No `days` or `weeks` = a milestone (shown as a ◆).
     • When a contractor confirms a date, add  start: 'YYYY-MM-DD'  to pin
       it. The page warns you if that is earlier than the work it needs.

   TASK FIELDS
     id       short unique name, used by `after`
     name     what shows on the chart
     trade    one of the keys in `trades` below
     days     working days of work      weeks   calendar weeks
     after    ['id', ...]  tasks that must finish first
     lag      extra working days to wait after those finish (e.g. drying)
     before + lead   start `lead` working days before another task starts
     start    'YYYY-MM-DD'  pin to a confirmed date
     status   'done' | 'in-progress' | 'delayed'   (leave out = planned)
     notes    anything the team should know

   PRIVACY: anyone with the link can see this page. Don't put door or
   alarm codes, your address, phone numbers, or budget figures here.
   ===================================================================== */

window.RENOVATION = {
  project: {
    name: 'Kitchen Renovation',
    start: '2026-11-02',      // PLACEHOLDER: set your real start date
    updated: '2026-10-24',    // change this whenever you edit the file
    editUrl: 'https://github.com/Route3ralph/kitchen-renovation/edit/main/schedule.js',
    // Days nobody works. Add your contractors' days off as you learn them.
    holidays: [
      '2026-11-26', '2026-11-27',   // Thanksgiving
      '2026-12-24', '2026-12-25',   // Christmas
      '2026-12-31', '2027-01-01',   // New Year
    ],
  },

  // `who` is shown to everyone. Name and company only, no phone numbers.
  trades: {
    decorator:   { name: 'Decorator & selections', who: 'Decorator: TBD',            color: '#9333ea' },
    owner:       { name: 'Owner: orders & logistics', who: 'Homeowner',              color: '#64748b' },
    carpenter:   { name: 'Carpenter',              who: 'TBD',                       color: '#92622f' },
    plumber:     { name: 'Plumber',                who: 'TBD',                       color: '#2563eb' },
    electrician: { name: 'Electrician',            who: 'TBD',                       color: '#ca8a04' },
    painter:     { name: 'Painter',                who: 'TBD',                       color: '#db2777' },
    flooring:    { name: 'Flooring',               who: 'TBD',                       color: '#ea580c' },
    tile:        { name: 'Tile',                   who: 'TBD',                       color: '#16a34a' },
    countertops: { name: 'Countertops',            who: 'Fabricator: TBD',           color: '#0891b2' },
    inspection:  { name: 'Permits & inspections',  who: 'Local building department', color: '#b91c1c' },
  },

  phases: [
    {
      name: 'Design & selections',
      tasks: [
        { id: 'design', name: 'Design consult & final layout', trade: 'decorator', days: 3,
          notes: 'Lock the layout first. Cabinets, plumbing and electrical locations all depend on it.' },
        { id: 'appliances', name: 'Confirm appliance models & specs', trade: 'owner', days: 3, after: ['design'],
          notes: 'Cabinet sizes, outlet locations and water/gas lines depend on the exact appliance models.' },
        { id: 'sel-cabinets', name: 'Choose cabinets: style, color & hardware', trade: 'decorator', days: 5, after: ['design'],
          notes: 'Cabinets have the longest lead time in the project, so this choice drives the whole schedule.' },
        { id: 'sel-fixtures', name: 'Choose sink, faucet & light fixtures', trade: 'decorator', days: 4, after: ['design'],
          notes: 'The plumber and electrician need these specs before rough-in.' },
        { id: 'sel-counters', name: 'Choose countertop material & edge', trade: 'decorator', days: 4, after: ['sel-cabinets'] },
        { id: 'sel-floor', name: 'Choose flooring', trade: 'decorator', days: 4, after: ['sel-cabinets'] },
        { id: 'sel-tile', name: 'Choose backsplash tile', trade: 'decorator', days: 4, after: ['sel-counters'],
          notes: 'Choose tile with the countertop sample in hand.' },
        { id: 'sel-paint', name: 'Choose paint colors (sample on the walls)', trade: 'decorator', days: 5, after: ['sel-tile', 'sel-floor'],
          notes: 'Pick paint last: it is the easiest finish to match to cabinets, counters and tile. Look at samples in morning and evening light.' },
        { id: 'permit', name: 'Building permit: apply & approval', trade: 'inspection', weeks: 3, after: ['design'],
          notes: 'Check with your local building department. Approval times vary by town, and electrical or plumbing changes usually need a permit.' },
      ],
    },
    {
      name: 'Orders & deliveries',
      tasks: [
        { id: 'order-cabinets', name: 'Cabinets on order (≈6 weeks)', trade: 'owner', weeks: 6, after: ['sel-cabinets', 'appliances'],
          notes: 'Semi-custom cabinets often take 4–8 weeks. Replace 6 with your supplier\'s real lead time.' },
        { id: 'cabinets-arrive', name: 'Cabinets delivered', trade: 'owner', after: ['order-cabinets'],
          notes: 'Inspect every box for damage and missing pieces on delivery day.' },
        { id: 'order-materials', name: 'Tile, flooring & fixtures on order (≈2 weeks)', trade: 'owner', weeks: 2, after: ['sel-tile', 'sel-floor', 'sel-fixtures'] },
        { id: 'materials-arrive', name: 'Tile, flooring & fixtures delivered', trade: 'owner', after: ['order-materials'],
          notes: 'Wood and vinyl flooring usually needs a few days indoors to acclimate before installation.' },
        { id: 'order-appliances', name: 'Appliances on order (≈4 weeks)', trade: 'owner', weeks: 4, after: ['appliances'] },
      ],
    },
    {
      name: 'Demolition & rough-in',
      tasks: [
        { id: 'prep', name: 'Set up temporary kitchen & dust protection', trade: 'owner', days: 1, before: 'demo', lead: 1 },
        { id: 'demo', name: 'Demolition & haul-away', trade: 'carpenter', days: 2, after: ['permit'], before: 'cabinets-arrive', lead: 15,
          notes: 'Timed to begin about 3 working weeks before cabinets arrive, so your kitchen stays usable as long as possible.' },
        { id: 'plumb-rough', name: 'Plumbing rough-in', trade: 'plumber', days: 2, after: ['demo', 'sel-fixtures'] },
        { id: 'elec-rough', name: 'Electrical rough-in: circuits, boxes, lighting', trade: 'electrician', days: 3, after: ['demo', 'sel-fixtures', 'appliances'] },
        { id: 'rough-insp', name: 'Rough-in inspection', trade: 'inspection', days: 1, after: ['plumb-rough', 'elec-rough'],
          notes: 'Walls cannot be closed until this passes.' },
      ],
    },
    {
      name: 'Walls, paint & floors',
      tasks: [
        { id: 'drywall', name: 'Drywall patch & repair', trade: 'carpenter', days: 3, after: ['rough-insp'] },
        { id: 'paint-1', name: 'Prime & paint walls and ceiling', trade: 'painter', days: 3, after: ['drywall', 'sel-paint'],
          notes: 'Painting before the cabinets and floor go in is faster and keeps drips off new surfaces.' },
        { id: 'flooring', name: 'Install flooring', trade: 'flooring', days: 3, after: ['paint-1', 'materials-arrive'],
          notes: 'Floating vinyl (LVP) floors are sometimes installed after the cabinets instead. Confirm the order with your installer.' },
      ],
    },
    {
      name: 'Cabinets & countertops',
      tasks: [
        { id: 'cab-install', name: 'Install cabinets', trade: 'carpenter', days: 4, after: ['flooring', 'cabinets-arrive'] },
        { id: 'template', name: 'Countertop template', trade: 'countertops', days: 1, after: ['cab-install', 'materials-arrive'],
          notes: 'The sink and faucet must be on site. The fabricator templates around them.' },
        { id: 'fabricate', name: 'Countertop fabrication (≈2 weeks)', trade: 'countertops', weeks: 2, after: ['template'] },
        { id: 'counters', name: 'Install countertops', trade: 'countertops', days: 1, after: ['fabricate'] },
        { id: 'trim', name: 'Trim, toe kicks & cabinet hardware', trade: 'carpenter', days: 2, after: ['cab-install'] },
      ],
    },
    {
      name: 'Finishes',
      tasks: [
        { id: 'backsplash', name: 'Tile backsplash', trade: 'tile', days: 3, after: ['counters', 'materials-arrive'] },
        { id: 'plumb-finish', name: 'Plumbing finish: sink, faucet, dishwasher', trade: 'plumber', days: 1, after: ['counters'] },
        { id: 'elec-finish', name: 'Electrical finish: outlets, switches, lights', trade: 'electrician', days: 2, after: ['backsplash'],
          notes: 'Comes after the backsplash so outlet covers sit flush on the tile.' },
        { id: 'appliance-install', name: 'Appliance delivery & hookup', trade: 'owner', days: 1, after: ['plumb-finish', 'elec-finish', 'order-appliances'] },
        { id: 'paint-2', name: 'Final paint & touch-ups', trade: 'painter', days: 2, after: ['trim', 'backsplash', 'elec-finish'] },
      ],
    },
    {
      name: 'Closeout',
      tasks: [
        { id: 'final-insp', name: 'Final inspection', trade: 'inspection', days: 1, after: ['elec-finish', 'plumb-finish', 'appliance-install'] },
        { id: 'walkthrough', name: 'Decorator walkthrough & styling', trade: 'decorator', days: 1, after: ['paint-2'] },
        { id: 'punch', name: 'Punch list & final clean', trade: 'owner', days: 2, after: ['final-insp', 'paint-2', 'walkthrough'],
          notes: 'Walk the room with each trade and list anything unfinished before final payment.' },
        { id: 'complete', name: 'Kitchen complete', trade: 'owner', after: ['punch'] },
      ],
    },
  ],
};
