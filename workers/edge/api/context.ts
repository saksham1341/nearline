import type { Services } from "../services.ts";

export interface ApiUser {
  id: string;
  /** The public 8-hex author label. */
  author: string;
}

export interface ApiContext {
  services: Services;
  user: ApiUser;
  now: number;
}
