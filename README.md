# Maritime Prime Painting CRM

The CRM from the Claude Design project, set up to run as a website and an installable phone app with shared data and personal logins.

## What is in this folder

| Path | What it is |
| --- | --- |
| `src/index.html` | The whole app: screens, styles and logic |
| `src/backend.js` | Sign-in, saving and live sync with the database |
| `src/config.js` | **The two Supabase values go here** |
| `src/sw.js`, `src/manifest.webmanifest` | Make the site installable on phones |
| `supabase/setup.sql` | Creates the database tables and access rules |
| `.github/workflows/pages.yml` | Publishes `src/` as the website on every push |
| `Maritime Prime CRM (standalone).html` | Untouched original export from Claude Design |

Open `src/index.html?demo` in a browser to look around with the design's sample data. Nothing is saved in that mode.

## One-time setup

### 1. Supabase (database and logins)

1. Create a free project at supabase.com. Pick a region near you and save the database password somewhere safe.
2. Open **SQL Editor > New query**, paste everything from `supabase/setup.sql`, and press **Run**. It should say "Success".
3. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key into `src/config.js`. Never use the `service_role` key.

### 2. GitHub (code and website)

1. Install Git for Windows and create a new **public** repository on GitHub (free website hosting needs a public repository; the code contains no customer data or secret keys).
2. Push this folder to it.
3. In the repository: **Settings > Pages > Source: GitHub Actions**. After a minute the site is live at `https://YOUR-NAME.github.io/REPO-NAME/`.

### 3. Connect the two

In Supabase: **Authentication > URL Configuration**. Set **Site URL** to the website address from step 2 and add the same address under **Redirect URLs**. This makes the confirmation and password-reset emails link back to the site.

### 4. First sign-in

1. Open the website, choose **First time? Create your account**, and sign up with your own email.
2. Open the confirmation email, then sign in. **The first person to sign in becomes the owner**, so do this before sharing the address.
3. On the **Team** page add managers under **Office accounts**, and put each painter's email on their crew card (**Edit > Email**).
4. Each person then opens the site, chooses **Create your account** with that same email, and sets their own password.

### Install on a phone

- **iPhone:** open the site in Safari, tap Share, then **Add to Home Screen**.
- **Android:** open the site in Chrome, tap the menu, then **Install app** / **Add to Home screen**.

## Who can see what

- **Owner and managers:** everything.
- **Sales:** dashboard, leads and jobs.
- **Painters:** only their own crew's scheduled jobs (address, client phone, specs, notes, photos), their week, and their crewmates. They can clock in/out, log hours, add receipts and add photos. Prices, costs, margins, leads, quotes and estimate sheets are never sent to a painter's phone; this is enforced by the database, not just hidden on screen.

Removing someone's email from the Team page cuts off their access immediately.

## Good to know

- Supabase's built-in email sender only allows a few sign-up emails per hour. If several people sign up at once, some may need to wait and try again.
- Files are limited to 50 MB each on the free Supabase plan.
- If two people edit the same lead or job at the same moment, the last save wins.
