import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { latLngToCanonicalLocation, locationToShard } from "../../packages/geo/index.ts";
import type { ChatMessage, ServerFrame } from "../../packages/protocol/index.ts";
import {
  MAX_MESSAGE_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  type ProximityScope,
} from "../../packages/shared/constants.ts";
import { bytesToHex, sha256 } from "../../packages/shared/encoding.ts";

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
  transcript: required<HTMLElement>("transcript"),
  newMessages: required<HTMLButtonElement>("new-messages"),
  empty: required<HTMLElement>("empty-state"),
  composer: required<HTMLFormElement>("composer"),
  input: required<HTMLTextAreaElement>("message-input"),
  send: required<HTMLButtonElement>("send-button"),
  roomDialog: required<HTMLDialogElement>("room-dialog"),
  roomForm: required<HTMLFormElement>("room-form"),
  roomId: required<HTMLInputElement>("room-id"),
  roomPassphrase: required<HTMLInputElement>("room-passphrase"),
  leaveRoom: required<HTMLButtonElement>("leave-room"),
  toast: required<HTMLElement>("toast"),
};

const scopeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-scope]"));
const roomButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-room-button]"));
const authorLabels = Array.from(document.querySelectorAll<HTMLElement>("[data-author-label]"));
const connectionDots = Array.from(document.querySelectorAll<HTMLElement>("[data-connection-dot]"));
const connectionLabels = Array.from(document.querySelectorAll<HTMLElement>("[data-connection-label]"));
const logoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-logout]"));
const identityMenus = Array.from(document.querySelectorAll<HTMLDetailsElement>("[data-identity-menu]"));
const scopeCopy: Record<ProximityScope, string> = {
  11: "Close",
  10: "Nearby",
  9: "Wide",
};

let socket: WebSocket | null = null;
let pendingSocket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let currentLocation = "";
let currentAuthor = "";
let currentRoomTag = "";
let currentScope: ProximityScope = 10;
let watchId: number | null = null;
let toastTimer: number | undefined;
const messageIds = new Set<string>();
const renderedItems: HTMLElement[] = [];
let laneSteps = 0;

void initialize();

async function initialize(): Promise<void> {
  bindEvents();
  syncViewportHeight();
  try {
    const session = await api<{ authenticated: boolean; author?: string }>("/api/auth/session");
    if (session.authenticated) {
      currentAuthor = session.author ?? "";
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
    sendFrame({ type: "scope", scope: currentScope });
    appendTimelineEvent(`Range changed to ${elements.scope.selectedOptions[0]?.textContent ?? "nearby"}`);
  });
  for (const button of scopeButtons) {
    button.addEventListener("click", () => {
      const scope = Number(button.dataset.scope) as ProximityScope;
      if (scope === currentScope) return;
      elements.scope.value = String(scope);
      elements.scope.dispatchEvent(new Event("change"));
    });
  }
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
  elements.composer.addEventListener("submit", sendMessage);
  elements.input.addEventListener("input", updateComposer);
  elements.newMessages.addEventListener("click", scrollToLatest);
  elements.transcript.addEventListener("scroll", () => {
    if (isNearTranscriptBottom()) elements.newMessages.hidden = true;
  }, { passive: true });
  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
  applyScopeVisuals();
  setConnectionState(false, "Connecting…");
  window.setInterval(refreshRelativeTimes, 30_000);
}

async function authenticatePasskey(): Promise<void> {
  await withBusy(elements.login, async () => {
    requirePasskeySupport();
    const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
      "/api/auth/login/options", { method: "POST" },
    );
    const credential = await startAuthentication({ optionsJSON });
    await api("/api/auth/login/verify", jsonInit(credential));
    const session = await api<{ author: string }>("/api/auth/session");
    currentAuthor = session.author;
    await prepareLocation();
  }, "authenticate");
}

async function registerPasskey(): Promise<void> {
  await withBusy(elements.register, async () => {
    requirePasskeySupport();
    const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
      "/api/auth/register/options", { method: "POST" },
    );
    const credential = await startRegistration({ optionsJSON });
    const result = await api<{ author: string }>("/api/auth/register/verify", jsonInit(credential));
    currentAuthor = result.author;
    await prepareLocation();
  }, "create");
}

async function prepareLocation(): Promise<void> {
  showView("location");
  elements.location.hidden = false;
  elements.location.disabled = false;
  elements.location.textContent = "Use my location";
  elements.locationCopy.textContent = "Nearline works by showing conversations around you. Location is required to continue.";
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
      showView("chat");
      const changedShard = Boolean(previous) && locationToShard(previous) !== locationToShard(location);
      if (changedShard) {
        appendTimelineEvent("Moved into a new area");
      }
      if (!previous || changedShard) {
        connect(location);
      } else {
        sendFrame({ type: "position", location });
      }
    },
    (error) => {
      disconnect(false);
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

function connect(nextLocation: string): void {
  window.clearTimeout(reconnectTimer);
  pendingSocket?.close(1000, "Superseded");
  setConnectionState(false, "Connecting…");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Scope and room travel with the upgrade so the server never attaches this socket to the public default filter.
  const params = new URLSearchParams({ location: nextLocation, scope: String(currentScope), room: currentRoomTag });
  const next = new WebSocket(`${protocol}//${window.location.host}/api/socket?${params}`);
  pendingSocket = next;
  let ready = false;

  next.addEventListener("message", (event) => {
    let frame: ServerFrame;
    try { frame = JSON.parse(String(event.data)) as ServerFrame; } catch { return; }
    if (frame.type === "ready") {
      ready = true;
      reconnectAttempt = 0;
      if (pendingSocket === next) pendingSocket = null;
      const previous = socket;
      socket = next;
      currentAuthor = frame.author;
      for (const label of authorLabels) label.textContent = `@${frame.author}`;
      setConnectionState(true, "Connected");
      appendTimelineEvent("Connected");
      // Covers a scope or room change made while this socket was still connecting.
      if (frame.scope !== currentScope) sendFrame({ type: "scope", scope: currentScope });
      if (frame.roomTag !== currentRoomTag) sendFrame({ type: "room", tag: currentRoomTag });
      if (previous && previous !== next) previous.close(1000, "Moved shards");
      updateComposer();
      return;
    }
    if (frame.type === "message") appendMessage(frame.message);
    if (frame.type === "error") handleServerError(frame.code);
  });
  next.addEventListener("close", () => {
    const wasActive = socket === next;
    const wasLatestAttempt = pendingSocket === next;
    if (wasLatestAttempt) pendingSocket = null;
    // Superseded attempts and sockets closed on purpose (moved shards, logout, lost location) end here.
    if (!wasActive && !wasLatestAttempt) return;
    if (wasActive) {
      socket = null;
      setConnectionState(false, "Reconnecting…");
      appendTimelineEvent("Disconnected");
      updateComposer();
    }
    if (ready) scheduleReconnect();
    else void recoverFailedConnection();
  });
  next.addEventListener("error", () => next.close());
}

/** A rejected upgrade is indistinguishable from a network failure, so ask whether the session still exists. */
async function recoverFailedConnection(): Promise<void> {
  try {
    const session = await api<{ authenticated: boolean }>("/api/auth/session");
    if (!session.authenticated) {
      endSession();
      return;
    }
  } catch {
    // Offline or the service is down: keep retrying with backoff.
  }
  if (!socket) setConnectionState(false, "Reconnecting…");
  scheduleReconnect();
}

function endSession(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  disconnect(false);
  currentLocation = "";
  showView("auth");
  showToast("Your session ended. Continue with your passkey to rejoin.");
}

function scheduleReconnect(): void {
  if (!currentLocation) return;
  const delay = Math.min(12_000, 500 * 2 ** reconnectAttempt) + Math.random() * 300;
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => connect(currentLocation), delay);
}

function disconnect(reconnect: boolean): void {
  window.clearTimeout(reconnectTimer);
  const pending = pendingSocket;
  pendingSocket = null;
  pending?.close(1000, "Location unavailable");
  const active = socket;
  socket = null;
  if (active) appendTimelineEvent("Disconnected");
  active?.close(1000, "Location unavailable");
  if (reconnect) scheduleReconnect();
}

function sendMessage(event: SubmitEvent): void {
  event.preventDefault();
  const body = elements.input.value;
  if (!body.trim() || Array.from(body).length > MAX_MESSAGE_CHARS || socket?.readyState !== WebSocket.OPEN) return;
  sendFrame({ type: "message", body });
  elements.input.value = "";
  resizeComposer();
  updateComposer();
}

function appendMessage(message: ChatMessage): void {
  if (messageIds.has(message.id)) return;
  messageIds.add(message.id);
  elements.empty.hidden = true;
  const article = document.createElement("article");
  article.className = `message${message.author === currentAuthor ? " own" : ""}`;
  article.dataset.messageId = message.id;
  article.style.setProperty("--stud", authorColor(message.author));
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = `@${message.author}`;
  if (message.author === currentAuthor) {
    const you = document.createElement("span");
    you.className = "you-label";
    you.textContent = "you";
    author.append(you);
  }
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = message.body;
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = new Date(message.ts).toISOString();
  time.dataset.messageTime = String(message.ts);
  time.title = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(message.ts);
  time.textContent = formatMessageTime(message.ts);
  meta.append(author, time);
  article.append(meta, body);
  insertTimelineItem(article, message.ts, true);
  advanceLane();
}

function authorColor(author: string): string {
  const hue = Number.parseInt(author.slice(0, 4), 16) % 360;
  return Number.isFinite(hue) ? `hsl(${hue} 72% 66%)` : "";
}

function advanceLane(): void {
  laneSteps += 1;
  document.documentElement.style.setProperty("--lane-steps", String(laneSteps));
}

async function enterRoom(): Promise<void> {
  const roomId = elements.roomId.value;
  const passphrase = elements.roomPassphrase.value;
  if (!roomId || !passphrase) return;
  const joined = new Uint8Array(
    new TextEncoder().encode(roomId).length + 1 + new TextEncoder().encode(passphrase).length,
  );
  const roomBytes = new TextEncoder().encode(roomId);
  const passphraseBytes = new TextEncoder().encode(passphrase);
  joined.set(roomBytes, 0);
  joined.set(passphraseBytes, roomBytes.length + 1);
  currentRoomTag = bytesToHex(await sha256(joined));
  sendFrame({ type: "room", tag: currentRoomTag });
  setRoomButtonLabel("Private");
  for (const button of roomButtons) button.classList.add("active");
  document.documentElement.classList.add("room-active");
  applyScopeVisuals();
  elements.input.placeholder = "Message this filter…";
  elements.leaveRoom.hidden = false;
  elements.roomForm.reset();
  elements.roomDialog.close();
  setConnectionState(socket?.readyState === WebSocket.OPEN, socket?.readyState === WebSocket.OPEN ? "Connected" : "Reconnecting…");
  appendTimelineEvent("Private filter active");
}

async function logout(): Promise<void> {
  for (const button of logoutButtons) button.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.reload();
  } catch (error) {
    console.error(error);
    for (const button of logoutButtons) button.disabled = false;
    showToast("Couldn’t log out. Try again.");
  }
}

function leaveRoom(): void {
  currentRoomTag = "";
  sendFrame({ type: "room", tag: "" });
  setRoomButtonLabel("Public");
  for (const button of roomButtons) button.classList.remove("active");
  document.documentElement.classList.remove("room-active");
  applyScopeVisuals();
  elements.input.placeholder = "Message nearby…";
  elements.leaveRoom.hidden = true;
  elements.roomDialog.close();
  setConnectionState(socket?.readyState === WebSocket.OPEN, socket?.readyState === WebSocket.OPEN ? "Connected" : "Reconnecting…");
  appendTimelineEvent("Public chat active");
}

function appendTimelineEvent(label: string, timestamp = Date.now()): void {
  if (elements.chatView.hidden) return;
  elements.empty.hidden = true;
  const event = document.createElement("div");
  event.className = "timeline-event";
  event.dataset.timestamp = String(timestamp);
  const text = document.createElement("span");
  text.textContent = label;
  event.append(text);
  insertTimelineItem(event, timestamp, false);
}

function insertTimelineItem(item: HTMLElement, timestamp: number, isMessage: boolean): void {
  const shouldFollow = isNearTranscriptBottom() || item.classList.contains("own") || renderedItems.length === 0;
  item.dataset.timestamp = String(timestamp);
  const nextIndex = renderedItems.findIndex((existing) => Number(existing.dataset.timestamp) > timestamp);
  if (nextIndex === -1) {
    renderedItems.push(item);
    elements.transcript.append(item);
  } else {
    const nextItem = renderedItems[nextIndex]!;
    renderedItems.splice(nextIndex, 0, item);
    elements.transcript.insertBefore(item, nextItem);
  }
  while (renderedItems.length > MAX_TRANSCRIPT_MESSAGES) {
    const removed = renderedItems.shift();
    if (!removed) break;
    const messageId = removed.dataset.messageId;
    if (messageId) messageIds.delete(messageId);
    removed.remove();
  }
  if (shouldFollow) {
    requestAnimationFrame(scrollToLatest);
  } else if (isMessage) {
    elements.newMessages.hidden = false;
  }
}

function sendFrame(frame: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function handleServerError(code: string): void {
  const messages: Record<string, string> = {
    RATE_LIMITED: "You’re sending too quickly.",
    INVALID_MESSAGE: "That message can’t be sent.",
    MESSAGE_REJECTED: "The message couldn’t be delivered. Try again.",
    SHARD_CHANGED: "Your location changed. Reconnecting…",
  };
  showToast(messages[code] ?? "Something went wrong.");
  if (code === "SHARD_CHANGED") connect(currentLocation);
}

function updateComposer(): void {
  resizeComposer();
  elements.send.disabled = !elements.input.value.trim() || socket?.readyState !== WebSocket.OPEN;
}

function resizeComposer(): void {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 120)}px`;
}

function setConnectionState(online: boolean, label: string): void {
  document.documentElement.classList.toggle("live", online);
  for (const dot of connectionDots) dot.classList.toggle("online", online);
  for (const text of connectionLabels) text.textContent = label;
}

function applyScopeVisuals(): void {
  const scope = scopeCopy[currentScope];
  document.documentElement.dataset.scope = String(currentScope);
  elements.scopeStatus.textContent = currentRoomTag ? `${scope} · private filter` : scope;
  elements.desktopViewStatus.textContent = `${currentRoomTag ? "Private filter" : "Public"} · ${scope}`;
  elements.desktopViewDescription.textContent = currentRoomTag ? "Private filter active" : "Open local conversation";
  for (const button of scopeButtons) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.scope) === currentScope));
  }
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

function isNearTranscriptBottom(): boolean {
  return elements.transcript.scrollHeight - elements.transcript.scrollTop - elements.transcript.clientHeight < 96;
}

function scrollToLatest(): void {
  elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior: "smooth" });
  elements.newMessages.hidden = true;
}

function formatMessageTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 45_000) return "now";
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m`;
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function refreshRelativeTimes(): void {
  for (const time of elements.transcript.querySelectorAll<HTMLTimeElement>(".message-time")) {
    const timestamp = Number(time.dataset.messageTime);
    if (Number.isFinite(timestamp)) time.textContent = formatMessageTime(timestamp);
  }
}

function showView(view: "auth" | "location" | "chat"): void {
  elements.authView.hidden = view !== "auth";
  elements.locationView.hidden = view !== "location";
  elements.chatView.hidden = view !== "chat";
  if (view === "chat") {
    for (const label of authorLabels) label.textContent = currentAuthor ? `@${currentAuthor}` : "@--------";
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      requestAnimationFrame(() => elements.input.focus({ preventScroll: true }));
    }
  }
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3_200);
}

async function withBusy(
  button: HTMLButtonElement,
  action: () => Promise<void>,
  operation: "create" | "authenticate",
): Promise<void> {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "Waiting for passkey…";
  try { await action(); } catch (error) {
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

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
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
