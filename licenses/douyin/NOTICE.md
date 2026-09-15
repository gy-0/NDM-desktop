# Native Douyin resolver attribution

NDM ports and modifies URL classification, media-candidate ranking, and endpoint behavior from jiji262/douyin-downloader (MIT), and a_bogus/X-Bogus signatures from Johnserf-Seed/f2 and Evil0ctal/Douyin_TikTok_Download_API (Apache-2.0). NDM's Swift implementation, request-scoped cookie handling, error classification and host integration are modified works. Upstream Python source is not executed by NDM.

Audited references on 2026-09-16:

- https://github.com/jiji262/douyin-downloader/tree/26b2eb2e28217ad1646ce55f180c51cc9de77c3c
- https://github.com/Johnserf-Seed/f2/blob/7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3/f2/utils/abogus.py
- https://github.com/Evil0ctal/Douyin_TikTok_Download_API/tree/42784ffc83a72a516bfe952153ad7e2a3998d16c

Copyright (c) 2026 jiji262. Copyright (c) 2024 Johnserf-Seed. Copyright Evil0ctal and Douyin_TikTok_Download_API contributors. The accompanying MIT and Apache-2.0 files retain their full license texts.

API signatures are not a guarantee that a site will accept a request. The current user-video API verification returned HTTP 403 despite readable browser cookies. NDM preserves that failure category and directs users to the existing NDM Relay workflow on the playable source page.
