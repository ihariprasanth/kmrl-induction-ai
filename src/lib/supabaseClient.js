import { createClient } from "@supabase/supabase-js";

/* =========================================================================
   SUPABASE CLIENT
   Reads the project URL + anon key from Vite env vars. Create a file
   named `.env` in the project root (copy `.env.example`) with:

     VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
     VITE_SUPABASE_ANON_KEY=your-anon-public-key

   Both values come from Supabase Dashboard -> Project Settings -> API.
   Never commit the real `.env` file or the service_role key anywhere in
   this frontend code — only the anon/public key belongs here.
========================================================================= */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    "[supabaseClient] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set. " +
      "Copy .env.example to .env and fill in your Supabase project credentials."
  );
}

export const supabase = createClient(supabaseUrl || "", supabaseAnonKey || "");
