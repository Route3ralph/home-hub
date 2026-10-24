/* Connection settings for the Home Hub database (Supabase).
   The key below is a "publishable" key and is meant to be public:
   your data is protected by the database's row-level security rules,
   not by hiding this key. Never put a "secret" or "service_role" key here. */
window.HOME_HUB_CONFIG = {
  supabaseUrl: 'https://bvabaalvbgluidgbcurm.supabase.co',
  supabaseKey: 'sb_publishable_0UbOlPUbzaGyLvGBVSPnag_Qjcd0EMU',
  // Set to true once the send-email function and its SendGrid secrets are set up (see README).
  emailSending: false,
};
