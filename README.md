# Gift lists

Shared Christmas wish lists for two people (up to six per session).
Each person writes a list, the others can claim gifts from it, and the list
owner never sees what has been claimed. Changes appear on the other person's
screen within about 5 seconds.

## How people and sessions work

- **Start a session:** press **Generate code**, enter your name, press **Start session**.
  You land on your own list, ready to fill in.
- **Invite the other person:** press **Copy invite link** and send it.
- **Join:** they open the link and see the names already in the session. They
  either **tap their name** to join as that person, or **type a new name** and
  press **Add me and join** to add themselves. Either way they land on their own
  list. Tapping your own name on a second device gets you your existing list.
- **People panel:** add someone's name ahead of time, or **Remove** a person.
  Removing deletes their list, turns any gifts they had claimed back into
  unclaimed, and sends them to the start screen.
- **Switch sessions:** press **Switch session**. Sessions you have opened are
  saved on this device (name, your person, room code) with **Open** and **Forget**
  buttons. Give each a name of your own; only you see it.
- **Delete a session:** in **People**, press **Delete session**. Everything in it
  is wiped for everyone.

## Deploy on Vercel

1. Put this folder in a Git repository (GitHub, GitLab or Bitbucket) and push it.
2. In Vercel, choose **Add New → Project**, import the repository, set the
   framework preset to **Other**, leave the build command and output directory
   empty, and deploy. The `public` folder is served automatically and
   `api/room.js` becomes the API.
3. In the project, open **Storage** (or the **Marketplace**), add **Upstash for
   Redis** (the free plan is plenty) and connect it to the project. This adds the
   environment variables `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
   If your integration uses different names, `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` also work.
4. Redeploy once so the function picks up the variables.
5. Open the site and start a session.

Command-line alternative: `npm i -g vercel`, run `vercel` in this folder, add the
Redis integration in the dashboard, then run `vercel --prod`.

## Try it locally (no account needed)

```
npm run dev
```

Open http://localhost:3000. This runs the real API against an in-memory fake of
Redis, so everything is lost when you stop it. Open a second browser or a
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
- **Typos create people.** Typing "Alx" instead of "Alex" adds a second person.
  Use **Remove** in the People panel to clean it up.
- **Data** is stored in Redis and expires 60 days after the last change. Change
  `TTL_SECONDS` in `api/room.js` to alter this.
- **Limits**: 300 gifts per session, 6 people per session, 120 characters per gift.
- **Not included**: rate limiting. If you want it, enable Vercel's firewall rate
  limiting for `/api/room`.
