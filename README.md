# Gift lists

Shared Christmas wish lists for two people (up to six per session).
Each person writes a list, the others can claim gifts from it, and the list
owner never sees what has been claimed. Changes appear on the other person's
screen within about 5 seconds.

## How people and sessions work

- **Start a session:** enter your name and press **Start session**. That is the
  whole registration: no code to make or type (one is created for you), no
  password. You land on your own list with the **Gift** box ready. Add gifts one
  at a time: the gift, plus an optional link and note.
- **Edit or remove a gift:** each of your gifts has **Edit** and **Remove**. Edit
  loads the gift into the form at the top (name, link, note); change it and press
  **Save changes**, or **Cancel**. What you type is kept while the list refreshes.
  If someone has already claimed the gift, the claim stays, and they see
  "Changed since you claimed it" with a **Got it** button, so nobody buys the
  wrong thing. You never see who has claimed what.
- **Room code:** every session shows its code (like `xmas-abcde-fghij`) under the
  session name, with a **Copy** button, and saved sessions on the start screen show
  theirs with **Copy code**. Tap the code to select all of it. Anyone with the code
  can use **Join a session** on any device, then tap their name. Codes are grouped
  in fives so they are easy to read out or type; keep the dashes.
- **Invite the other person:** press **Invite**. Send the link by **WhatsApp**,
  **text message** or **email** (each opens with the message already written),
  with **Share…** (your phone's share sheet, where available), or **Copy link**.
  Optionally type their name first: the link then opens straight to "Join as
  Alex" (or, if Alex hasn't been added yet, with the name already filled in), so
  joining is one tap. Names you have already added are suggested as you type.
- **Join:** they open the link, see the names already in the session (the one
  the link was made for is highlighted), and either
  **tap their name** to join as that person or type a new name and press
  **Add me and join**. They can also paste the whole invite message, or just the
  code, into **Join a session** on the start screen. Tapping your own name on a
  second device gets you your existing list.
- **Move between sessions:** the strip across the top of a session has a tab for
  each session you have opened on this device. Tap one to jump to it. **+ New or
  join** opens the start screen, which has a **Back** button to return.
- **Move between people:** the tabs under the header (**My list**, **Sam's list**,
  ...) scroll sideways when there are many. You can swipe left or right on a list
  to move to the next or previous person, or use the arrow keys, Home and End.
- **Switch who you are:** if two people share a device, open **People** (or tap
  **Not you?**) and press **Switch to** next to a name. No code needed.
- **Fix your name:** in **People**, under **Your name**, type the corrected name
  and press **Save name**. Your list and your claims move with you. If you are
  signed in on another device, it will ask you to tap your name again.
- **People panel:** add someone's name ahead of time, or **Remove** a person.
  Removing deletes their list, turns any gifts they had claimed back into
  unclaimed, and sends them to the start screen. You can also rename the session
  here (only you see the name) and see the room code.
- **Session names:** a new session starts as "Session" plus four characters.
  Once someone else joins it becomes "Christmas with" followed by their names,
  unless you rename it under **People** (only you see the name).
- **Delete a session:** in **People**, press **Delete session**. Everything in it
  is wiped for everyone. **Forget** on the start screen only removes it from your
  device.

## Look and feel

- **Snow and tree:** small snowflakes fall behind the page, and a Christmas tree
  with blinking lights sits on the start screen and in the session header. It's
  decoration only; no data is involved.
- **Reduced motion:** people who have "reduce motion" turned on in their device
  settings get no snow, and a tree with steady lights.
- **Battery and data:** snow stops drawing, and the app stops checking for updates,
  while the tab is hidden. When you come back it refreshes straight away.

## Deploy on Vercel

1. Put this folder in a Git repository (GitHub, GitLab or Bitbucket) and push it.
2. In Vercel, choose **Add New → Project**, import the repository, set the
   framework preset to **Other**, leave the build command and output directory
   empty, and deploy. The `public` folder is served automatically and
   `api/room.js` becomes the API.
3. In the project, open **Storage** (or the **Marketplace**), choose **Upstash**
   and create a **Redis** database (the free plan is plenty). Connect it to this
   project with **all environments ticked** (Production, Preview, Development).
   This adds connection settings to the project's environment variables. The app
   finds them whatever prefix you chose, as long as they are Upstash's REST URL
   and token (names ending in `REST_API_URL` and `REST_API_TOKEN`, or
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`). A plain `REDIS_URL`
   on its own is not enough.
4. **Redeploy** (Deployments, the ⋯ menu on the latest one, Redeploy). Settings added to a
   project only reach deployments made after they were added, so this step matters.
5. Open `https://your-site/api/health`. It should say `{"ok":true,"database":"connected"}`.
   If not, it says what is wrong (see Troubleshooting below). Then open the site and
   start a session.

Command-line alternative: `npm i -g vercel`, run `vercel` in this folder, add the
Redis integration in the dashboard, then run `vercel --prod`.

## Troubleshooting

Open `https://your-site/api/health` first. It never shows keys or stored data.

| What it says | What to do |
| --- | --- |
| `connected` | The database is fine. If something else fails, check the Logs tab in Vercel. |
| `not-configured`, "No Redis connection found" | No Upstash REST settings reached this deployment. Connect Upstash for Redis under Storage with all environments ticked, then **redeploy**. |
| `not-configured`, "plain Redis URL" | Only a `REDIS_URL` is present. Create an **Upstash** Redis database instead, which provides the REST URL and token this app needs. |
| `rejected` | The token is wrong or was rotated. Reconnect the database to the project (or update the token under Settings, Environment Variables), then redeploy. |
| `unreachable` | The database can't be reached. Check it still exists in the Upstash dashboard and isn't paused or deleted. |

The same problems show up as a plain sentence when someone tries to start a
session (for example "The server isn't connected to its database yet"), instead
of a vague error. The exact cause is also written to the function logs in Vercel
(project, Logs), without any keys.

## Try it locally (no account needed)

```
npm run dev
```

Open http://localhost:3000. This runs the real API against an in-memory fake of
Redis, so everything is lost when you stop it. It sends the same security headers
as Vercel (including the Content-Security-Policy), so anything the policy would
block on Vercel also fails here. Open a second browser or a
private window to act as the other person.

## Run the tests

```
npm test
```

The tests run the real API handler against an in-memory fake of Redis, so they
need no network or account.

## What to know

- **The room code is the shared secret.** Anyone who has it can see the names in
  the session and join by picking one or adding their own. Send it only to the
  people you're sharing with.
  Generated codes have about 50 bits of randomness; short codes you type
  yourself are weaker.
- **Names are not passwords.** Anyone with the code can tap any name and enter
  as that person, and a removed person can rejoin by adding their name again. The
  "owner can't see claims" rule stops accidental spoilers, not someone determined
  to peek. To shut someone out for good, delete the session and start a new one
  with a new code.
- **Typos create people.** Typing "Alx" instead of "Alex" when joining adds a
  person called Alx. If you notice straight away, use **Your name** in the People
  panel to fix it; otherwise **Remove** the stray person.
- **Data** is stored in Redis and expires 60 days after the last change. Change
  `TTL_SECONDS` in `api/room.js` to alter this.
- **Limits**: 300 gifts per session, 6 people per session, 120 characters per gift.
- **Not included**: rate limiting. If you want it, enable Vercel's firewall rate
  limiting for `/api/room`.
