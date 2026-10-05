import type { Anchor, PostView } from "../../packages/protocol/index.ts";
import { THREAD_TTL_MS } from "../../packages/shared/constants.ts";

/** One tick per minute of life a post can have. The theme decides how ticks look (tabs, a bar…). */
export const LIFE_TICKS = Math.round(THREAD_TTL_MS / 60_000);
/** How many paper stocks the theme defines (`data-paper="0"` … `"7"`). */
const PAPER_STOCKS = 8;

const SVG_NS = "http://www.w3.org/2000/svg";

export type IconName = "reply" | "repost" | "like" | "delete" | "back";

const ICON_PATHS: Record<IconName, string> = {
  reply: "M6.5 3.5 2.5 7.5l4 4M2.5 7.5h6.5a4.5 4.5 0 0 1 4.5 4.5v1",
  repost: "M3 6.5v-1a2 2 0 0 1 2-2h7.5m0 0-2-2m2 2-2 2M13 9.5v1a2 2 0 0 1-2 2H3.5m0 0 2 2m-2-2 2-2",
  like: "M8 13.5S2.5 10.3 2.5 6.4A2.9 2.9 0 0 1 8 5a2.9 2.9 0 0 1 5.5 1.4c0 3.9-5.5 7.1-5.5 7.1Z",
  delete: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5",
  back: "M10 3 5 8l5 5",
};

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon", `icon-${name}`);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

/** Road-stud colour from the author's hash, so speakers stay distinguishable without profiles. */
export function authorColor(author: string): string {
  const hue = Number.parseInt(author.slice(0, 4), 16) % 360;
  return Number.isFinite(hue) ? `hsl(${hue} 72% 66%)` : "";
}

/** A stable paper stock and a small tilt per author, so the same person always looks the same. */
export function authorStyle(author: string): { paper: number; tilt: number } {
  const value = Number.parseInt(author.slice(0, 6), 16);
  if (!Number.isFinite(value)) return { paper: 7, tilt: 0 };
  return { paper: value % PAPER_STOCKS, tilt: ((value >> 3) % 9 - 4) / 8 };
}

export function formatAge(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 45_000) return "now";
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m`;
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

export interface PostCardOptions {
  post: PostView;
  threadId: string;
  variant: "feed" | "focus" | "reply";
  currentAuthor: string;
  now: number;
  likeCount: number;
  likedByMe: boolean;
  replyCount?: number;
  repostCount?: number;
  repostedByMe?: boolean;
  via?: Anchor;
  expiresAt?: number;
  pending?: boolean;
}

export function renderPostCard(options: PostCardOptions): HTMLElement {
  const { post, threadId, variant } = options;
  const own = post.author === options.currentAuthor;
  const article = document.createElement("article");
  article.className = ["post", `post-${variant}`, own ? "own" : "", options.pending ? "pending" : "", post.deleted ? "deleted" : ""]
    .filter(Boolean).join(" ");
  article.dataset.threadId = threadId;
  article.dataset.postId = post.id;
  article.style.setProperty("--stud", authorColor(post.author));
  const look = authorStyle(post.author);
  article.dataset.paper = String(post.deleted ? 7 : look.paper);
  article.dataset.mark = post.deleted ? "" : post.author.slice(0, 2);
  article.style.setProperty("--tilt", `${look.tilt}deg`);
  if (variant === "feed") {
    article.dataset.action = "open";
    article.tabIndex = 0;
  }

  if (options.via?.kind === "repost") {
    const via = document.createElement("p");
    via.className = "post-via";
    via.append(icon("repost"), document.createTextNode(`@${options.via.byAuthor} reposted here`));
    article.append(via);
  }

  const meta = document.createElement("div");
  meta.className = "post-meta";
  const author = document.createElement("span");
  author.className = "post-author";
  author.textContent = `@${post.author}`;
  if (own) {
    const you = document.createElement("span");
    you.className = "you-label";
    you.textContent = "you";
    author.append(you);
  }
  const time = document.createElement("time");
  time.className = "post-time";
  time.dateTime = new Date(post.createdAt).toISOString();
  time.dataset.ts = String(post.createdAt);
  time.textContent = formatAge(post.createdAt, options.now);
  meta.append(author, time);

  const body = document.createElement("p");
  body.className = "post-body";
  body.textContent = post.deleted ? "[deleted]" : post.body;
  article.append(meta, body);

  if (!post.deleted && !options.pending) article.append(actionRow(options, own));

  if (options.expiresAt !== undefined) {
    const life = document.createElement("div");
    life.className = "life";
    life.dataset.expiresAt = String(options.expiresAt);
    life.setAttribute("aria-hidden", "true");
    for (let tick = 0; tick < LIFE_TICKS; tick += 1) life.append(document.createElement("span"));
    article.append(life);
  }
  return article;
}

function actionRow(options: PostCardOptions, own: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "post-actions";
  row.append(actionButton("reply", "Reply", options, options.replyCount));
  if (options.repostCount !== undefined) {
    const repost = actionButton("repost", options.repostedByMe ? "Reposted" : "Repost here", options, options.repostCount);
    repost.setAttribute("aria-pressed", String(Boolean(options.repostedByMe)));
    repost.disabled = Boolean(options.repostedByMe);
    row.append(repost);
  }
  const like = actionButton("like", options.likedByMe ? "Unlike" : "Like", options, options.likeCount);
  like.setAttribute("aria-pressed", String(options.likedByMe));
  row.append(like);
  if (own) row.append(actionButton("delete", "Delete", options));
  return row;
}

function actionButton(
  name: "reply" | "repost" | "like" | "delete",
  label: string,
  options: PostCardOptions,
  count?: number,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `post-action action-${name}`;
  button.dataset.action = name;
  button.dataset.threadId = options.threadId;
  button.dataset.postId = options.post.id;
  button.setAttribute("aria-label", count === undefined ? label : `${label}, ${count}`);
  button.append(icon(name));
  if (count !== undefined) {
    const value = document.createElement("span");
    value.className = "count";
    value.textContent = String(count);
    button.append(value);
  }
  return button;
}
