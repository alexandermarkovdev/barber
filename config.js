// Supabase connection for the website and the admin page.
// Copy both values from Supabase → Project Settings → API (or "API Keys").
//
//   supabaseUrl      the Project URL, e.g. https://abcdefghijkl.supabase.co
//   supabaseAnonKey  the "anon" public key (or the newer "publishable" key, sb_publishable_…)
//
// These two are meant to be public and are safe on GitHub Pages: the database rules decide what
// visitors can do. NEVER put the service_role / secret key here.
//
// While these still say YOUR-…, the website's booking form runs as a demo and saves nothing.
window.RAZOR_CONFIG = {
  supabaseUrl: 'https://bpcsrvlcyfbfsoxvvlvc.supabase.co',
  supabaseAnonKey: 'sb_publishable_6CU1i42BgbJbWoexfigrqw_2FScc6Ha'
};
