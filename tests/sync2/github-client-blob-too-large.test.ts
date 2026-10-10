// Field, 2026-10-11 (phone): a 95 MiB blob got GitHub's 422 "Sorry, your
// input was too large to process" — and was retried five more times, ~47 s of
// mobile upload each, before the drain restarted and did it all again.
// Too large is final: one attempt, a BlobTooLargeError (NOT a ValidationError,
// which the drain reads as "head moved" and restarts the batch on).

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import GithubClient from "../../src/github/client";
import Logger from "../../src/logger";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import { BlobTooLargeError, ValidationError } from "../../src/errors";
import { Vault, installRequestFaultInjector } from "../../mock-obsidian";

describe("createBlob: GitHub's 'input was too large' is final", () => {
  it("one attempt, BlobTooLargeError", async () => {
    const root = path.join(os.tmpdir(), `blob-too-large-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
    const vault = new Vault(root);
    const settings = { ...DEFAULT_SETTINGS, githubToken: "t", githubOwner: "o", githubRepo: "r", githubBranch: "main" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new GithubClient(settings, new Logger(vault as any, "git-easy-sync", false) as any);
    let posts = 0;
    installRequestFaultInjector({
      intercept(url: string, method: string) {
        if (method === "POST" && url.includes("/git/blobs")) {
          posts++;
          return {
            status: 422,
            body: JSON.stringify({
              message:
                "Sorry, your input was too large to process. Consider creating the blob in a local clone of the repository and then pushing it to GitHub.",
            }),
          };
        }
        return null;
      },
    });
    try {
      const err = await client.createBlob({ content: "QUJD", retry: true }).catch((e) => e);
      expect(err).toBeInstanceOf(BlobTooLargeError);
      expect(err).not.toBeInstanceOf(ValidationError);
      expect(posts).toBe(1);
    } finally {
      installRequestFaultInjector(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
