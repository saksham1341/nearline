import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { latLngToCanonicalLocation, locationToScopeCell } from "../../packages/geo/index.ts";
import type { ActionRequest, Anchor, ErrorCode, FeedTab, PostView, ThreadSummary } from "../../packages/protocol/index.ts";
import {
  MAX_MESSAGE_CHARS,
  POLL_FEED_MS,
  POLL_THREAD_MS,
  THREAD_TTL_MS,
  type ProximityScope,
} from "../../packages/shared/constants.ts";
import { bytesToHex, sha256 } from "../../packages/shared/encoding.ts";
import { fetchEngagement, fetchFeed, fetchThread, sendAction } from "./api.ts";
import { FeedState } from "./feed-state.ts";
import { Poller } from "./poller.ts";
import { refreshTimes, renderFeed } from "./render-feed.ts";
import { renderThread } from "./render-thread.ts";

const elements = {
  authView: required<HTMLElement>("auth-view"),
  locationView: required<HTMLElement>("location-view"),
  chatView: required<HTMLElement>("chat-view"),
  login: required<HTMLButtonElement>("login-button"),
  register: required<HTMLButtonElement>("register-button"),
  location: required<HTMLButtonElement>("location-button"),
  locationCopy: required<HTMLElement>("location-copy"),
  scopeStatus: required<HTMLElement>("scope-status"),
  desktopViewStatus: required<HTMLElement>("desktop-view-status"),
  desktopViewDescription: required<HTMLElement>("desktop-view-description"),
  scope: required<HTMLSelectElement>("scope-select"),
  feed: required<HTMLElement>("feed"),
  feedList: required<HTMLElement>("feed-list"),
  empty: required<HTMLElement>("empty-state"),
  emptyTitle: required<HTMLElement>("empty-title"),
  emptyCopy: required<HTMLElement>("empty-copy"),
  loadMore: required<HTMLButtonElement>("load-more"),
  newPosts: required<HTMLButtonElement>("new-posts"),
  composer: required<HTMLFormElement>("composer"),
  input: required<HTMLTextAreaElement>("message-input"),
  send: required<HTMLButtonElement>("send-button"),
  threadView: required<HTMLElement>("thread-view"),
  threadBody: required<HTMLElement>("thread-body"),
  threadBack: required<HTMLButtonElement>("thread-back"),
  threadUp: required<HTMLButtonElement>("thread-up"),
  replyComposer: required<HTMLFormElement>("reply-composer"),
  replyInput: required<HTMLTextAreaElement>("reply-input"),
  replySend: required<HTMLButtonElement>("reply-send"),
  replyTarget: required<HTMLElement>("reply-target"),
  replyCancel: required<HTMLButtonElement>("reply-cancel"),
  roomDialog: required<HTMLDialogElement>("room-dialog"),
  roomForm: required<HTMLFormElement>("room-form"),
  roomId: required<HTMLInputElement>("room-id"),
  roomPassphrase: required<HTMLInputElement>("room-passphrase"),
  leaveRoom: required<HTMLButtonElement>("leave-room"),
  toast: required<HTMLElement>("toast"),
};

const scopeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-scope]"));
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
const roomButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-room-button]"));
const authorLabels = Array.from(document.querySelectorAll<HTMLElement>("[data-author-label]"));
const syncDots = Array.from(document.querySelectorAll<HTMLElement>("[data-sync-dot]"));
const syncLabels = Array.from(document.querySelectorAll<HTMLElement>("[data-sync-label]"));
const logoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-logout]"));
const identityMenus = Array.from(document.querySelectorAll<HTMLDetailsElement>("[data-identity-menu]"));

const scopeCopy: Record<ProximityScope, string> = { 11: "Close", 10: "Nearby", 9: "Wide" };

const ERROR_COPY: Partial<Record<ErrorCode, string>> = {
  RATE_LIMITED: "You’re going too fast. Wait a moment.",
  INVALID_MESSAGE: "That post can’t be sent.",
  THREAD_NOT_FOUND: "That thread has faded.",
  THREAD_EXPIRED: "That thread has faded.",
  NOT_VISIBLE: "That thread is out of your range now.",
  PARENT_NOT_FOUND: "That post is gone.",
  POST_NOT_FOUND: "That post is gone.",
  THREAD_FULL: "This thread is full.",
  ALREADY_REPOSTED: "You already reposted this.",
  NOT_AUTHOR: "You can only delete your own posts.",
  UNAVAILABLE: "Couldn’t reach Nearline. Try again.",
};

const state = new FeedState();
const feedPoller = new Poller(POLL_FEED_MS, pollFeed);
const threadPoller = new Poller(POLL_THREAD_MS, pollThread);

let currentLocation = "";
let currentAuthor = "";
let currentRoomTag = "";
let currentScope: ProximityScope = 10;
let activeTab: FeedTab = "latest";
let replyParentId: string | null = null;
let watchId: number | null = null;
let toastTimer: number | undefined;
let renderQueued = false;
let laneSteps = 0;
let unseenNewPosts = 0;

void initialize();

async function initialize(): Promise<void> {
  bindEvents();
  syncViewportHeight();
  try {
    const session = await authApi<{ authenticated: boolean; author?: string }>("/api/auth/session");
    if (session.authenticated) {
      setAuthor(session.author ?? "");
      await prepareLocation();
      return;
    }
  } catch {
    showToast("The service is unavailable. Try again shortly.");
  }
  showView("auth");
}

function bindEvents(): void {
  elements.login.addEventListener("click", () => void authenticatePasskey());
  elements.register.addEventListener("click", () => void registerPasskey());
  elements.location.addEventListener("click", () => beginLocation(false));
  elements.scope.addEventListener("change", () => {
    currentScope = Number(elements.scope.value) as ProximityScope;
    applyScopeVisuals();
    refreshView();
  });
  for (const button of scopeButtons) {
    button.addEventListener("click", () => {
      const scope = Number(button.dataset.scope) as ProximityScope;
      if (scope === currentScope) return;
      elements.scope.value = String(scope);
      elements.scope.dispatchEvent(new Event("change"));
    });
  }
  for (const button of tabButtons) button.addEventListener("click", () => selectTab(button.dataset.tab as FeedTab));
  for (const button of roomButtons) button.addEventListener("click", openRoomDialog);
  for (const button of logoutButtons) button.addEventListener("click", () => void logout());
  document.addEventListener("click", (event) => {
    for (const menu of identityMenus) {
      if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") for (const menu of identityMenus) menu.open = false;
  });
  elements.roomForm.addEventListener("submit", (event) => {
    if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") return;
    event.preventDefault();
    void enterRoom();
  });
  elements.leaveRoom.addEventListener("click", leaveRoom);

  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPost();
  });
  elements.input.addEventListener("input", updateComposers);
  elements.input.addEventListener("keydown", submitOnEnter(elements.composer));
  elements.replyComposer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitReply();
  });
  elements.replyInput.addEventListener("input", updateComposers);
  elements.replyInput.addEventListener("keydown", submitOnEnter(elements.replyComposer));
  elements.replyCancel.addEventListener("click", () => setReplyTarget(null));

  elements.feedList.addEventListener("click", handlePostClick);
  elements.feedList.addEventListener("keydown", handlePostKey);
  elements.threadBody.addEventListener("click", handlePostClick);
  elements.threadBack.addEventListener("click", () => {
    if ((history.state as { thread?: string } | null)?.thread) history.back();
    else closeThread();
  });
  elements.threadUp.addEventListener("click", focusUp);
  elements.loadMore.addEventListener("click", () => void loadMore());
  elements.newPosts.addEventListener("click", () => {
    elements.feed.scrollTo({ top: 0, behavior: "smooth" });
    hideNewPosts();
  });
  elements.feed.addEventListener("scroll", () => {
    if (elements.feed.scrollTop < 80) hideNewPosts();
  }, { passive: true });
  window.addEventListener("popstate", () => {
    if (state.open && !(history.state as { thread?: string } | null)?.thread) closeThread();
  });
  document.addEventListener("visibilitychange", syncPolling);
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);

  window.setInterval(() => refreshTimes(document.body, state.now()), prefersReducedMotion() ? 60_000 : 1_000);
  window.setInterval(() => {
    if (state.prune(state.now()).length > 0) scheduleRender();
  }, 5_000);
  window.setInterval(() => {
    if (activeTab !== "trending") return;
    state.resortTrending(state.now());
    scheduleRender();
  }, 15_000);

  applyScopeVisuals();
  setSyncState(false, "Connecting…");
}

// ---------- Authentication ----------

async function authenticatePasskey(): Promise<void> {
  await withBusy(elements.login, async () => {
    requirePasskeySupport();
    const optionsJSON = await authApi<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
      "/api/auth/login/options", { method: "POST" },
    );
    const credential = await startAuthentication({ optionsJSON });
    await authApi("/api/auth/login/verify", jsonInit(credential));
    const session = await authApi<{ author: string }>("/api/auth/session");
    setAuthor(session.author);
    await prepareLocation();
  }, "authenticate");
}

async function registerPasskey(): Promise<void> {
  await withBusy(elements.register, async () => {
    requirePasskeySupport();
    const optionsJSON = await authApi<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
      "/api/auth/register/options", { method: "POST" },
    );
    const credential = await startRegistration({ optionsJSON });
    const result = await authApi<{ author: string }>("/api/auth/register/verify", jsonInit(credential));
    setAuthor(result.author);
    await prepareLocation();
  }, "create");
}

async function logout(): Promise<void> {
  for (const button of logoutButtons) button.disabled = true;
  try {
    await authApi("/api/auth/logout", { method: "POST" });
    window.location.reload();
  } catch (error) {
    console.error(error);
    for (const button of logoutButtons) button.disabled = false;
    showToast("Couldn’t log out. Try again.");
  }
}

function endSession(): void {
  stopPolling();
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  currentLocation = "";
  state.reset();
  state.closeOpen();
  showView("auth");
  showToast("Your session ended. Continue with your passkey to rejoin.");
}

function setAuthor(author: string): void {
  currentAuthor = author;
  for (const label of authorLabels) label.textContent = author ? `@${author}` : "@--------";
}

// ---------- Location ----------

async function prepareLocation(): Promise<void> {
  showView("location");
  elements.location.hidden = false;
  elements.location.disabled = false;
  elements.location.textContent = "Use my location";
  elements.locationCopy.textContent = "Nearline shows posts from around you. Location is required to continue.";
  if (!("geolocation" in navigator)) {
    elements.locationCopy.textContent = "This browser does not provide location access.";
    elements.location.disabled = true;
    return;
  }
  if (!("permissions" in navigator)) return;
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    if (permission.state === "granted") {
      beginLocation(true);
      return;
    }
    if (permission.state === "denied") {
      elements.locationCopy.textContent = "Location is required for Nearline. Allow access in your browser settings to continue.";
      elements.location.textContent = "Retry location";
    }
  } catch {
    // Some browsers expose geolocation without supporting its Permissions API state.
  }
}

function beginLocation(automatic: boolean): void {
  if (!("geolocation" in navigator)) {
    elements.locationCopy.textContent = "This browser does not provide location access.";
    return;
  }
  elements.location.disabled = true;
  elements.location.hidden = automatic;
  elements.location.textContent = "Locating…";
  if (automatic) elements.locationCopy.textContent = "Finding your local line…";
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const location = latLngToCanonicalLocation(position.coords.latitude, position.coords.longitude);
      if (location === currentLocation) return;
      const previous = currentLocation;
      currentLocation = location;
      if (!previous) {
        showView("chat");
        return;
      }
      if (locationToScopeCell(previous, currentScope) !== locationToScopeCell(location, currentScope)) refreshView();
    },
    (error) => {
      stopPolling();
      showView("location");
      elements.location.hidden = false;
      elements.location.disabled = false;
      elements.location.textContent = "Retry location";
      elements.locationCopy.textContent = error.code === error.PERMISSION_DENIED
        ? "Location is required for Nearline. Allow access in your browser settings to continue."
        : "Location is unavailable. Check your connection and try again.";
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
}

// ---------- Polling ----------

function viewerFields(): { cell: string; scope: ProximityScope; room: string } {
  return { cell: locationToScopeCell(currentLocation, currentScope), scope: currentScope, room: currentRoomTag };
}

function viewKey(tab: FeedTab): string {
  return currentLocation ? `${locationToScopeCell(currentLocation, currentScope)}|${currentScope}|${currentRoomTag}|${tab}` : "";
}

function syncPolling(): void {
  if (document.hidden || elements.chatView.hidden || !currentLocation) {
    stopPolling();
    return;
  }
  feedPoller.start();
  if (state.open) threadPoller.start();
}

function stopPolling(): void {
  feedPoller.stop();
  threadPoller.stop();
}

/** The view changed (range, room or location): forget what was shown and fetch afresh. */
function refreshView(): void {
  state.reset();
  hideNewPosts();
  feedPoller.poke();
  scheduleRender();
}

async function pollFeed(): Promise<boolean> {
  if (!currentLocation) return false;
  const tab = activeTab;
  const key = viewKey(tab);
  const result = await fetchFeed({ ...viewerFields(), tab, cursor: null }, state.etags[tab]);
  if (result.status === "unauthorized") {
    endSession();
    return false;
  }
  if (result.status === "error" || result.status === "gone") {
    setSyncState(false, "Offline — retrying");
    return false;
  }
  setSyncState(true, "Updated just now");
  if (result.status === "unchanged" || key !== viewKey(activeTab)) return false;
  state.setServerTime(result.data.serverTime);
  const added = state.applyHead(tab, result.data.items, result.data.nextCursor, result.etag);
  if (tab === "trending") state.resortTrending(state.now());
  if (added.length > 0 && tab === "latest") {
    advanceLane();
    if (elements.feed.scrollTop > 80) showNewPosts(added.length);
  }
  void loadEngagement();
  scheduleRender();
  return true;
}

async function loadMore(): Promise<void> {
  const tab = activeTab;
  const cursor = state.cursors[tab];
  if (!cursor || !currentLocation) return;
  const key = viewKey(tab);
  elements.loadMore.disabled = true;
  const result = await fetchFeed({ ...viewerFields(), tab, cursor }, null);
  elements.loadMore.disabled = false;
  if (result.status !== "fresh" || key !== viewKey(activeTab)) return;
  state.applyMore(tab, result.data.items, result.data.nextCursor);
  void loadEngagement();
  scheduleRender();
}

async function loadEngagement(): Promise<void> {
  const response = await fetchEngagement(state.takeUnflagged());
  if (!response) return;
  state.applyEngagement(response);
  scheduleRender();
}

async function pollThread(): Promise<boolean> {
  const open = state.open;
  if (!open) return false;
  const result = await fetchThread(open.id, currentRoomTag, open.etag);
  if (state.open?.id !== open.id) return false;
  if (result.status === "unauthorized") {
    endSession();
    return false;
  }
  if (result.status === "gone") {
    state.markFaded(open.id);
    threadPoller.stop();
    scheduleRender();
    return false;
  }
  if (result.status !== "fresh") return false;
  state.setServerTime(result.data.serverTime);
  state.applyTree(result.data, result.etag);
  scheduleRender();
  return true;
}

// ---------- Actions ----------

async function submitPost(): Promise<void> {
  const body = elements.input.value;
  if (!canSubmit(body) || !currentLocation) return;
  const id = crypto.randomUUID();
  const now = state.now();
  const via: Anchor = { cell11: currentLocation, kind: "root", byAuthor: currentAuthor, createdAt: now };
  if (activeTab !== "latest") selectTab("latest");
  state.addPendingThread(pendingSummary(id, body, now), via);
  elements.input.value = "";
  elements.feed.scrollTo({ top: 0 });
  scheduleRender();
  const result = await sendAction({ id, type: "post", ...viewerFields(), location: currentLocation, body });
  if (result.ok && result.postId) {
    state.confirmPendingThread(id, result.postId);
    feedPoller.poke();
  } else {
    state.failPendingThread(id);
    if (!elements.input.value) elements.input.value = body;
    handleActionError(result.ok ? "UNAVAILABLE" : result.code);
  }
  scheduleRender();
}

async function submitReply(): Promise<void> {
  const open = state.open;
  const body = elements.replyInput.value;
  if (!open || open.faded || !canSubmit(body)) return;
  const parentId = replyParentId ?? open.focusId ?? open.id;
  const id = crypto.randomUUID();
  state.addPendingReply({
    id, threadId: open.id, parentId, author: currentAuthor, body, createdAt: state.now(), deleted: false, likeCount: 0,
  });
  elements.replyInput.value = "";
  setReplyTarget(null);
  scheduleRender();
  const action: ActionRequest = { id, type: "reply", ...viewerFields(), threadId: open.id, parentId, body };
  const result = await sendAction(action);
  if (result.ok && result.postId) {
    state.confirmReply(id, result.postId);
    threadPoller.poke();
    feedPoller.poke();
  } else {
    state.failReply(id);
    if (!elements.replyInput.value) elements.replyInput.value = body;
    handleActionError(result.ok ? "UNAVAILABLE" : result.code);
  }
  scheduleRender();
}

async function toggleLike(threadId: string, postId: string): Promise<void> {
  const on = !state.likedPosts.has(postId);
  state.setLiked(postId, on, serverLikeCount(threadId, postId), state.now());
  scheduleRender();
  const result = await sendAction({ id: crypto.randomUUID(), type: "like", ...viewerFields(), threadId, postId, on });
  if (!result.ok) {
    state.setLiked(postId, !on, serverLikeCount(threadId, postId), state.now());
    handleActionError(result.code);
    scheduleRender();
  }
}

function serverLikeCount(threadId: string, postId: string): number {
  if (postId === threadId) return state.threads.get(threadId)?.summary.likeCount ?? state.open?.summary?.likeCount ?? 0;
  return state.open?.posts.find((post) => post.id === postId)?.likeCount ?? 0;
}

async function repost(threadId: string): Promise<void> {
  if (state.repostedThreads.has(threadId) || !currentLocation) return;
  const serverCount = state.threads.get(threadId)?.summary.repostCount ?? state.open?.summary?.repostCount ?? 0;
  state.setReposted(threadId, true, serverCount, state.now());
  scheduleRender();
  const result = await sendAction({ id: crypto.randomUUID(), type: "repost", ...viewerFields(), threadId, location: currentLocation });
  if (result.ok) {
    showToast("Reposted. People around you can see it now.");
    feedPoller.poke();
  } else if (result.code !== "ALREADY_REPOSTED") {
    state.setReposted(threadId, false, serverCount, state.now());
    handleActionError(result.code);
  }
  scheduleRender();
}

async function deletePost(threadId: string, postId: string): Promise<void> {
  if (!window.confirm("Delete this post? This can’t be undone.")) return;
  const result = await sendAction({ id: crypto.randomUUID(), type: "delete", threadId, postId });
  if (!result.ok) {
    handleActionError(result.code);
    return;
  }
  const open = state.open?.id === threadId ? state.open : null;
  const replies = open ? open.posts.length - 1 : state.threads.get(threadId)?.summary.replyCount ?? 0;
  if (postId === threadId && replies === 0) {
    state.remove(threadId);
    if (open) closeThread();
  } else {
    state.removePost(postId);
    threadPoller.poke();
  }
  feedPoller.poke();
  scheduleRender();
}

function handleActionError(code: ErrorCode): void {
  if (code === "UNAUTHORIZED") {
    endSession();
    return;
  }
  showToast(ERROR_COPY[code] ?? "Something went wrong.");
}

function pendingSummary(id: string, body: string, now: number): ThreadSummary {
  const root: PostView = { id, threadId: id, parentId: null, author: currentAuthor, body, createdAt: now, deleted: false, likeCount: 0 };
  return {
    id, roomTag: currentRoomTag, root, replyCount: 0, likeCount: 0, repostCount: 0, participantCount: 1,
    score: 0, scoreAt: now, lastActivityAt: now, expiresAt: now + THREAD_TTL_MS, version: 0,
  };
}

// ---------- Feed and thread interaction ----------

function handlePostClick(event: MouseEvent): void {
  const control = (event.target as Element).closest<HTMLElement>("[data-action]");
  if (!control) return;
  const threadId = control.dataset.threadId;
  const postId = control.dataset.postId ?? threadId;
  if (!threadId || !postId) return;
  switch (control.dataset.action) {
    case "open":
      if (window.getSelection()?.toString()) return;
      openThread(threadId);
      break;
    case "reply":
      openThread(threadId);
      setReplyTarget(postId);
      break;
    case "like":
      void toggleLike(threadId, postId);
      break;
    case "repost":
      void repost(threadId);
      break;
    case "delete":
      void deletePost(threadId, postId);
      break;
    case "focus":
      state.focus(postId === threadId ? null : postId);
      setReplyTarget(null);
      scheduleRender();
      break;
  }
}

function handlePostKey(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  const article = event.target instanceof HTMLElement && event.target.matches("article[data-action='open']") ? event.target : null;
  if (article?.dataset.threadId) openThread(article.dataset.threadId);
}

function openThread(threadId: string): void {
  if (state.open?.id !== threadId) {
    state.beginOpen(threadId);
    setReplyTarget(null);
    history.pushState({ thread: threadId }, "");
  }
  threadPoller.start();
  threadPoller.poke();
  scheduleRender();
  requestAnimationFrame(() => elements.threadBack.focus({ preventScroll: true }));
}

function closeThread(): void {
  state.closeOpen();
  threadPoller.stop();
  setReplyTarget(null);
  scheduleRender();
}

function focusUp(): void {
  const open = state.open;
  if (!open?.focusId) return;
  const parent = open.posts.find((post) => post.id === open.focusId)?.parentId ?? null;
  state.focus(parent === open.id ? null : parent);
  scheduleRender();
}

function setReplyTarget(postId: string | null): void {
  replyParentId = postId;
  const open = state.open;
  const post = postId && open
    ? open.posts.find((item) => item.id === postId) ?? (open.summary?.root.id === postId ? open.summary.root : undefined)
    : undefined;
  elements.replyTarget.textContent = post ? `Replying to @${post.author}` : "Reply to thread";
  elements.replyCancel.hidden = !post;
  if (post) requestAnimationFrame(() => elements.replyInput.focus({ preventScroll: true }));
}

function selectTab(tab: FeedTab): void {
  if (tab === activeTab) return;
  activeTab = tab;
  for (const button of tabButtons) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  hideNewPosts();
  if (tab === "trending") state.resortTrending(state.now());
  elements.feed.scrollTo({ top: 0 });
  feedPoller.poke();
  scheduleRender();
}

// ---------- Rendering ----------

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  const now = state.now();
  preserveScroll(() => renderFeed(elements.feedList, state, activeTab, { currentAuthor, now }));
  const empty = state.visibleIds(activeTab).length === 0;
  elements.empty.hidden = !empty;
  elements.emptyTitle.textContent = activeTab === "latest" ? "Quiet here" : "Nothing trending";
  elements.emptyCopy.textContent = activeTab === "latest" ? "Start the line." : "Threads trend once more than one person joins in.";
  elements.loadMore.hidden = empty || !state.cursors[activeTab];
  renderThreadPanel(now);
  refreshTimes(document.body, now);
  updateComposers();
}

function renderThreadPanel(now: number): void {
  const open = state.open;
  document.documentElement.classList.toggle("thread-open", Boolean(open));
  elements.threadView.hidden = !open;
  if (!open) return;
  renderThread(elements.threadBody, state, currentAuthor, now);
  elements.threadUp.hidden = !open.focusId;
  elements.replyComposer.hidden = open.faded;
}

/** Keeps the post under the reader's eye still when new posts arrive above it. */
function preserveScroll(update: () => void): void {
  const feed = elements.feed;
  if (feed.scrollTop <= 0) {
    update();
    return;
  }
  const anchor = Array.from(elements.feedList.children)
    .find((child) => (child as HTMLElement).offsetTop + (child as HTMLElement).offsetHeight > feed.scrollTop) as HTMLElement | undefined;
  const before = anchor?.offsetTop ?? 0;
  update();
  if (anchor?.isConnected) feed.scrollTop += anchor.offsetTop - before;
}

function updateComposers(): void {
  resize(elements.input);
  resize(elements.replyInput);
  elements.send.disabled = !canSubmit(elements.input.value) || !currentLocation;
  elements.replySend.disabled = !canSubmit(elements.replyInput.value) || !state.open || state.open.faded;
}

function canSubmit(body: string): boolean {
  return body.trim().length > 0 && Array.from(body).length <= MAX_MESSAGE_CHARS;
}

function resize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function submitOnEnter(form: HTMLFormElement): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
}

function setSyncState(online: boolean, label: string): void {
  document.documentElement.classList.toggle("live", online);
  for (const dot of syncDots) dot.classList.toggle("online", online);
  for (const text of syncLabels) text.textContent = label;
}

/** The lane's dashes step forward whenever a poll brings new posts. */
function advanceLane(): void {
  laneSteps += 1;
  document.documentElement.style.setProperty("--lane-steps", String(laneSteps));
}

function showNewPosts(count: number): void {
  unseenNewPosts += count;
  elements.newPosts.textContent = `${unseenNewPosts} new ${unseenNewPosts === 1 ? "post" : "posts"}`;
  elements.newPosts.hidden = false;
}

function hideNewPosts(): void {
  unseenNewPosts = 0;
  elements.newPosts.hidden = true;
}

// ---------- Range and private filters ----------

function applyScopeVisuals(): void {
  const scope = scopeCopy[currentScope];
  document.documentElement.dataset.scope = String(currentScope);
  elements.scopeStatus.textContent = currentRoomTag ? `${scope} · private filter` : scope;
  elements.desktopViewStatus.textContent = `${currentRoomTag ? "Private filter" : "Public"} · ${scope}`;
  elements.desktopViewDescription.textContent = currentRoomTag ? "Private filter active" : "Open local feed";
  for (const button of scopeButtons) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.scope) === currentScope));
  }
}

async function enterRoom(): Promise<void> {
  const roomId = elements.roomId.value;
  const passphrase = elements.roomPassphrase.value;
  if (!roomId || !passphrase) return;
  const roomBytes = new TextEncoder().encode(roomId);
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const joined = new Uint8Array(roomBytes.length + 1 + passphraseBytes.length);
  joined.set(roomBytes, 0);
  joined.set(passphraseBytes, roomBytes.length + 1);
  currentRoomTag = bytesToHex(await sha256(joined));
  setRoomButtonLabel("Private");
  for (const button of roomButtons) button.classList.add("active");
  document.documentElement.classList.add("room-active");
  elements.input.placeholder = "Post to this filter…";
  elements.leaveRoom.hidden = false;
  elements.roomForm.reset();
  elements.roomDialog.close();
  applyScopeVisuals();
  refreshView();
}

function leaveRoom(): void {
  currentRoomTag = "";
  setRoomButtonLabel("Public");
  for (const button of roomButtons) button.classList.remove("active");
  document.documentElement.classList.remove("room-active");
  elements.input.placeholder = "Post nearby…";
  elements.leaveRoom.hidden = true;
  elements.roomDialog.close();
  applyScopeVisuals();
  refreshView();
}

function setRoomButtonLabel(label: string): void {
  for (const button of roomButtons) {
    const text = button.querySelector<HTMLElement>("[data-room-button-label]");
    if (text) text.textContent = label;
  }
}

function openRoomDialog(): void {
  elements.roomDialog.showModal();
  requestAnimationFrame(() => elements.roomId.focus({ preventScroll: true }));
}

// ---------- Shell ----------

function showView(view: "auth" | "location" | "chat"): void {
  elements.authView.hidden = view !== "auth";
  elements.locationView.hidden = view !== "location";
  elements.chatView.hidden = view !== "chat";
  if (view === "chat" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    requestAnimationFrame(() => elements.input.focus({ preventScroll: true }));
  }
  syncPolling();
  scheduleRender();
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3_200);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function withBusy(
  button: HTMLButtonElement,
  action: () => Promise<void>,
  operation: "create" | "authenticate",
): Promise<void> {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "Waiting for passkey…";
  try {
    await action();
  } catch (error) {
    console.error(error);
    void reportPasskeyError(error, operation);
    if (error instanceof Error && error.message === "RATE_LIMITED") {
      showToast("Too many attempts from this network. Wait a minute and try again.");
    } else {
      showToast(operation === "create" ? "Couldn’t create passkey. Try again." : "Couldn’t use passkey. Try again.");
    }
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function requirePasskeySupport(): void {
  if (!("PublicKeyCredential" in window)) {
    throw new DOMException("This browser does not expose WebAuthn", "NotSupportedError");
  }
}

async function reportPasskeyError(error: unknown, operation: "create" | "authenticate"): Promise<void> {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown browser error";
  try {
    await fetch("/api/client-error", jsonInit({ area: "passkey", operation, name, message }));
  } catch {
    // Diagnostics must never replace or delay the user-facing failure state.
  }
}

function syncViewportHeight(): void {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--viewport-height", `${Math.round(height)}px`);
}

async function authApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function jsonInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
