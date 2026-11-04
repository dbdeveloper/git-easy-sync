# 1. Data Model

> **Not yet written.** Part of the SYNC2 reference ([overview](../SYNC2.md)).

This chapter will cover:

- The three places a file lives: Vault, Repo, and the baseline that ties them
- Hot metadata: the two-slot ping-pong keyed on a monotonic `seq`
- Cold metadata: per-file baselines in hash buckets
- The engine's invariants (I1–I7)
