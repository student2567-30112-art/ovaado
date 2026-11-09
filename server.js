const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const PUB = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
if (!PUB || !PRIV) {
  console.error("Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY environment variable");
  process.exit(1);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:you@example.com", PUB, PRIV);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const FILE = path.join(__dirname, "data.json");
let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {} }

const slim = (i) => ({
  id: String(i.id).slice(0, 40),
  subject: String(i.subject || "").slice(0, 80),
  task: String(i.task || "").slice(0, 120),
  due: Number(i.due) || 0,
  before: Number(i.before) || 0,
  done: !!i.done
});
const when = (t) => new Date(t).toLocaleString("th-TH", {
  timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit"
}) + " น.";

app.get("/api/key", (req, res) => res.json({ key: PUB }));
app.get("/health", (req, res) => res.send("ok"));

app.post("/api/sync", (req, res) => {
  const { subscription, items } = req.body || {};
  if (!subscription || !subscription.endpoint || !Array.isArray(items)) {
    return res.status(400).json({ error: "bad request" });
  }
  const t = Date.now();
  const old = db[subscription.endpoint];
  const oldSent = (old && old.sent) || {};
  const list = items.slice(0, 300).map(slim);
  const sent = {};
  for (const it of list) {
    for (const k of [it.id + ":w", it.id + ":d"]) if (oldSent[k]) sent[k] = true;
    // a reminder time that has already passed when the app syncs counts as handled
    if (t >= it.due) sent[it.id + ":d"] = true;
    if (it.before <= 0 || t >= it.due - it.before * 60000) sent[it.id + ":w"] = true;
  }
  db[subscription.endpoint] = { subscription, items: list, sent };
  save();
  res.json({ ok: true });
});

async function tick() {
  const now = Date.now();
  let changed = false;
  outer: for (const ep of Object.keys(db)) {
    const u = db[ep];
    for (const it of u.items) {
      if (it.done) continue;
      const label = it.subject + (it.task ? " — " + it.task : "");
      const jobs = [];
      if (it.before > 0 && now >= it.due - it.before * 60000 && now < it.due && !u.sent[it.id + ":w"]) {
        jobs.push([it.id + ":w", "ใกล้ถึงเวลาส่งแล้ว: " + it.subject, label + " · กำหนด " + when(it.due)]);
      }
      if (now >= it.due && now < it.due + 6 * 3600000 && !u.sent[it.id + ":d"]) {
        jobs.push([it.id + ":d", "ถึงเวลาส่งแล้ว: " + it.subject, label + " · กำหนด " + when(it.due)]);
      }
      for (const [key, title, body] of jobs) {
        u.sent[key] = true;
        changed = true;
        try {
          await webpush.sendNotification(u.subscription, JSON.stringify({ title, body, tag: key }));
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) {
            delete db[ep];
            continue outer;
          }
          console.error("push failed:", e.statusCode || e.message);
        }
      }
    }
  }
  if (changed) save();
}
setInterval(() => tick().catch(console.error), 20000);

app.listen(process.env.PORT || 3000, () => console.log("ovaado is running"));
