// A sample for check.js's own checks: the calls its scanner must find, and look-alikes it must
// skip. It is never loaded by the site, and the contract check doesn't scan it as site code.
/* global sb, core, task, from, to, name, args, base, y, f, fn, d */
// sb.rpc('in_a_line_comment', { x: 1 })
/* sb.from('in_a_block_comment') */
const quote = /'\)/g;
const text = "sb.rpc('in_a_string')";
const tpl = `sb.rpc('in_a_template')`;
sb.rpc('whoami');
sb.rpc("complete_task", { p_id: task.id, p_occurrence, 'p_done_on': f({ a: 1, b: [2, 3] }), p_note: `x ${y({ z: '}' })} w`, });
core.v2.call('agenda', { p_from: from, p_to: to });
core.v2.call(`late_items`);
sb?.rpc('dynamic_args', args);
sb.rpc(name, { a: 1 });
sb.rpc('with_spread', { ...base, p_x: 1 });
sb.from('tasks').select('*');
Array.from('not_a_table');
sb.storage.from('not_a_table_either');
const ratio = 10 / 2 / 5; sb.from('events').select(`id, ${quote}`);
const nested = `${sb.from('people').select()}`;
const { call } = core.v2;
fn.call(this, 'not_a_function');
async function callRpc(n, a) { return sb.rpc(n, a); }
call('heads_up', { p_day: d });
