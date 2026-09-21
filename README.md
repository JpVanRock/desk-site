# Desk Allocation Model (site)

Internal site for JP and Niko. Static files served by GitHub Pages. Data is **not** in this repo:
the page signs in through Supabase Auth and reads what the database's row-level security allows a
signed-in, approved desk member to see. The publishable key in `config.js` is public by design.

Never commit the Supabase secret (service-role) key, the Tiingo key, or any data export here.
Model logic, agent prompts, and data jobs live in the private `family-office-agentic-orchestration` repo.
