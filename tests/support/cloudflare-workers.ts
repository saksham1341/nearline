/** Test stand-in for the `cloudflare:workers` module: just enough of DurableObject for our classes. */
export class DurableObject<Env = unknown> {
  constructor(protected readonly ctx: unknown, protected readonly env: Env) {}
}
