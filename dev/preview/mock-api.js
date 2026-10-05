// Local UI preview: a fake Nearline API that lives in the page. It replaces fetch, geolocation and the
// session so the real client runs with no Worker, passkey or location. Loaded only by `npm run preview`.
//
// URL hash switches:  #gate   signed out (sign-in screen)
//                     #empty  signed in, nothing nearby
//                     #thread open the first thread once the feed loads
(() => {
  const MIN = 60_000;
  const TTL = 15 * MIN;
  const ME = "e05c8a1f";
  const CELL = "8b195da49b48fff";
  const signedIn = !location.hash.includes("gate");
  const empty = location.hash.includes("empty");
  const start = Date.now();
  let serial = 100;
  let version = 1;

  const uuid = () => crypto.randomUUID();
  const fixedId = (n) => `0190${String(n).padStart(4, "0")}-0000-7000-8000-${String(n).padStart(12, "0")}`;

  /** Every post, keyed by thread. Life is derived the way the server does it: 15 minutes after the newest activity below a post. */
  const threads = new Map();
  const liked = new Set();
  const reposted = new Set();

  function addPost({ id = uuid(), threadId, parentId = null, author, body, ago = 0, likes = 0, deleted = false, quietFor }) {
    const createdAt = start - ago;
    const post = { id, threadId: threadId ?? id, parentId, author, body, createdAt, deleted, likeCount: likes, activeAt: createdAt };
    if (quietFor !== undefined) post.activeAt = Date.now() - quietFor;
    if (!threads.has(post.threadId)) threads.set(post.threadId, { posts: [], reposts: [], via: null });
    threads.get(post.threadId).posts.push(post);
    return post;
  }

  function expiresAt(thread, post) {
    let newest = post.activeAt;
    const stack = [post.id];
    while (stack.length) {
      const parent = stack.pop();
      for (const child of thread.posts) {
        if (child.parentId !== parent) continue;
        newest = Math.max(newest, child.activeAt);
        stack.push(child.id);
      }
    }
    return newest + TTL;
  }

  function view(thread, post) {
    const { activeAt, ...rest } = post;
    return { ...rest, expiresAt: expiresAt(thread, post) };
  }

  function summary(threadId) {
    const thread = threads.get(threadId);
    const root = thread.posts.find((post) => post.parentId === null);
    const authors = new Set(thread.posts.map((post) => post.author));
    const lastActivityAt = Math.max(...thread.posts.map((post) => post.activeAt));
    return {
      id: threadId, roomTag: "", root: view(thread, root),
      replyCount: thread.posts.length - 1, likeCount: root.likeCount, repostCount: thread.reposts.length,
      participantCount: authors.size, score: thread.posts.length + root.likeCount, scoreAt: lastActivityAt,
      lastActivityAt, expiresAt: expiresAt(thread, root), version,
    };
  }

  function touch(thread, post) {
    post.activeAt = Date.now();
    version += 1;
  }

  // Seed a believable street corner.
  if (!empty) {
    const trucks = addPost({ id: fixedId(1), author: "3fa91c0e", body: "Anyone know if the food trucks by the fountain are still open?", ago: 4 * MIN, likes: 6, quietFor: 0.8 * MIN });
    const taco = addPost({ threadId: trucks.id, parentId: trucks.id, author: "b71e22d4", body: "The taco one is. Line's short right now.", ago: 3.5 * MIN, likes: 3, quietFor: 3.5 * MIN });
    const side = addPost({ threadId: trucks.id, parentId: taco.id, author: ME, body: "Which side of the fountain?", ago: 3 * MIN, quietFor: 3 * MIN });
    addPost({ threadId: trucks.id, parentId: side.id, author: "b71e22d4", body: "East side, by the benches", ago: 2 * MIN, likes: 1, quietFor: 0.8 * MIN });
    addPost({ threadId: trucks.id, parentId: trucks.id, author: "90d4f7a2", body: "Also the crepe cart closes at 9", ago: 9 * MIN, quietFor: 8.5 * MIN });
    liked.add(trucks.id);

    const umbrella = addPost({ author: "90d4f7a2", body: "Lost a blue umbrella near the north gate. Left one at the info desk too if it's yours.", ago: 7 * MIN, likes: 2, quietFor: 6.6 * MIN });
    threads.get(umbrella.id).reposts.push({ byAuthor: "b71e22d4", createdAt: start - 2 * MIN });
    addPost({ author: ME, body: "Thanks! heading over", ago: 10 * MIN, likes: 1, quietFor: 10.4 * MIN });
    addPost({ author: "5c21aa90", body: "Street band starting by the library steps in 5", ago: 12 * MIN, likes: 3, quietFor: 12.9 * MIN });
    addPost({ author: "c00ffee1", body: "", ago: 13 * MIN, deleted: true, quietFor: 13.8 * MIN });
  }

  function feed(url) {
    const now = Date.now();
    const tab = url.searchParams.get("tab") ?? "latest";
    let items = [...threads.keys()]
      .map((threadId) => {
        const thread = threads.get(threadId);
        const repost = thread.reposts.at(-1);
        const via = repost
          ? { cell11: CELL, kind: "repost", byAuthor: repost.byAuthor, createdAt: repost.createdAt }
          : { cell11: CELL, kind: "root", byAuthor: thread.posts[0].author, createdAt: thread.posts[0].createdAt };
        return { summary: summary(threadId), via };
      })
      .filter((item) => item.summary.expiresAt > now);
    if (tab === "trending") items = items.filter((item) => item.summary.participantCount > 1).sort((a, b) => b.summary.score - a.summary.score);
    else items.sort((a, b) => b.via.createdAt - a.via.createdAt);
    return { version: String(version), serverTime: now, items, nextCursor: null };
  }

  function act(request) {
    const thread = request.threadId ? threads.get(request.threadId) : null;
    switch (request.type) {
      case "post": {
        const post = addPost({ author: ME, body: request.body });
        post.clientRef = request.id;
        version += 1;
        return { ok: true, postId: post.id };
      }
      case "reply": {
        if (!thread) return { ok: false, code: "THREAD_NOT_FOUND" };
        const post = addPost({ threadId: request.threadId, parentId: request.parentId, author: ME, body: request.body });
        post.clientRef = request.id;
        version += 1;
        return { ok: true, postId: post.id };
      }
      case "like": {
        const post = thread?.posts.find((candidate) => candidate.id === request.postId);
        if (!post) return { ok: false, code: "POST_NOT_FOUND" };
        if (request.on && !liked.has(post.id)) { liked.add(post.id); post.likeCount += 1; touch(thread, post); }
        if (!request.on && liked.has(post.id)) { liked.delete(post.id); post.likeCount -= 1; version += 1; }
        return { ok: true };
      }
      case "repost": {
        if (!thread) return { ok: false, code: "THREAD_NOT_FOUND" };
        if (reposted.has(request.threadId)) return { ok: false, code: "ALREADY_REPOSTED" };
        reposted.add(request.threadId);
        thread.reposts.push({ byAuthor: ME, createdAt: Date.now() });
        touch(thread, thread.posts[0]);
        return { ok: true };
      }
      case "delete": {
        const post = thread?.posts.find((candidate) => candidate.id === request.postId);
        if (!post) return { ok: false, code: "POST_NOT_FOUND" };
        const hasReplies = thread.posts.some((candidate) => candidate.parentId === post.id);
        if (hasReplies) { post.deleted = true; post.body = ""; }
        else if (post.parentId === null) threads.delete(request.threadId);
        else thread.posts.splice(thread.posts.indexOf(post), 1);
        version += 1;
        return { ok: true };
      }
      default:
        return { ok: false, code: "BAD_REQUEST" };
    }
  }

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", etag: `W/"${version}"`, "x-server-time": String(Date.now()) },
    });
  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 120 + Math.random() * 180));

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const path = url.pathname;
    if (path.startsWith("/api/auth/session")) return later(json(signedIn ? { authenticated: true, author: ME } : { authenticated: false }));
    if (path.startsWith("/api/auth/")) return later(json({ ok: true }));
    if (path === "/api/feed") return later(json(feed(url)));
    if (path === "/api/me/engagement") return later(json({ liked: [...liked], reposted: [...reposted] }));
    if (path.startsWith("/api/threads/")) {
      const threadId = decodeURIComponent(path.split("/")[3] ?? "");
      const thread = threads.get(threadId);
      if (!thread) return later(json({ code: "THREAD_EXPIRED" }, 410));
      return later(json({ version, serverTime: Date.now(), summary: summary(threadId), posts: thread.posts.map((post) => view(thread, post)) }));
    }
    if (path === "/api/actions") {
      const request = JSON.parse(String(init.body ?? "{}"));
      return later(json({ id: request.id, ...act(request) }));
    }
    return later(json({ ok: true }));
  };

  // A fixed spot (central London) stands in for the browser's location.
  Object.defineProperty(navigator, "permissions", { value: { query: () => Promise.resolve({ state: "granted" }) } });
  Object.defineProperty(navigator, "geolocation", {
    value: {
      getCurrentPosition: (ok) => setTimeout(() => ok({ coords: { latitude: 51.5074, longitude: -0.1278, accuracy: 10 } }), 50),
      watchPosition: (ok) => { setTimeout(() => ok({ coords: { latitude: 51.5074, longitude: -0.1278, accuracy: 10 } }), 50); return 1; },
      clearWatch() {},
    },
  });
  if (location.hash.includes("thread")) {
    const open = setInterval(() => {
      const first = document.querySelector("#feed-list article");
      if (!first) return;
      clearInterval(open);
      first.click();
    }, 100);
  }
  console.info("[preview] Fake Nearline API active. Hash switches: #gate, #empty, #thread.");
})();
