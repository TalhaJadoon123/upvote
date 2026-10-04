# Launch copy

Everything below is written to be pasted. Nothing here claims a number we have not
measured; if you test a variant, replace the placeholder with your real result.

---

## 1. r/SaaS launch post (the meta one)

This is the post that starts the engine. Post it from a real account with real history —
a founder account with a comment history reads as a founder. Do not post it from a brand
new account.

**Title**

> I built a tool that writes Reddit posts for developers — here's what I learned shipping in public

**Body**

```
Three months ago I closed a sale in four days off a Reddit post. Four or five offers on
the table. Before that, Reddit had out-performed my SEO, my ads and my social combined
put together.

Then I did what every founder does after a win like that: tried to repeat it. And
discovered the real problem.

I can't write. Not "I'm busy" — I genuinely do not enjoy turning a commit into a
narrative, and every attempt at it came out sounding like a press release. Generic AI
copy is worse, because it has the fingerprints of a press release *and* the confidence
of a genius.

So I built the thing I wanted: a tool that watches my repos and drafts the post in my
own voice.

What makes it not-generic is mostly one decision. Upvote measures 29 dimensions of how
I write — sentence length, punctuation habits, how often I use first person, whether I
use em dashes or never do — and scores every draft 0-100 against that profile. Under 85
it throws the draft away and regenerates. I have never once overridden that gate, because
the drafts it rejects are exactly the ones that would have flopped.

It also reads subreddit sidebars and turns them into rules it can actually check. My
r/programming drafts have no links and required flair, because that's what the sidebar
says. It suggests the hour each subreddit actually responds, and it refuses to post more
than once a week in the same place.

And it posts from my Reddit account. Not a shared one. I know what happens to a tool
that posts from its own account.

Honest limitations, because I built this partly to find them:

- It needs a body of past writing. My first drafts scored in the 70s because I only gave
  it six samples. It says so instead of pretending.
- The offline mode (no model configured) is a deterministic composer. Good enough to
  judge structure, not good enough to post. I run it with a model.
- The rules parser is regex-based. It handles the rules I have actually seen, which is
  most of them, and it tells you which rule it matched.

It's $19/month. I'd rather be judged on whether the drafts sound like me than on the
feature list, so if it doesn't, tell me why in the comments — I read all of them and
reply from my own account.

Repo is in my profile. Happy to answer anything about how the scoring works or why
specific drafts got rejected.
```

**First comment (paste yourself)**

```
The thing I did not expect: measuring my own writing changed how I write. The profile
told me my paragraphs averaged 19 words and I almost never ask questions in posts. Both
true, neither conscious.

Technical detail if anyone wants it: the 85 threshold is a product decision, not a
statistical one. Below ~85 the drafts read as marketing to me. I tuned tolerance per
dimension — nobody cares if you use semicolons, everybody notices a 200-word opening
paragraph.
```

---

## 2. Hacker News

**Title**

> Show HN: Upvote – I built a Reddit post generator that refuses to sound like AI

**Body**

```
https://upvote.dev

Reddit is the highest-leverage growth channel I've measured for small software products,
and the hardest one to execute, because it requires writing in public and most
developers would rather not.

Upvote watches your GitHub repos, finds the shipping moments, and drafts Reddit posts in
your own voice. Five drafts per change, each with a subreddit, an hour and a first
comment.

The interesting engineering is in the rejection, not the generation:

- 29 measured style dimensions (sentence length, punctuation habits, formality, emoji
  density, hedging, capitalization...)
- every draft scored 0-100 against your profile; below 85 it regenerates
- subreddit sidebars parsed into machine-checkable rules (no self-promo, links in
  comments only, flair required, weekly limits)
- a per-subreddit best-time predictor, blended with your own results over time
- attribution from post to signup to revenue via UTM parameters
- a learning loop: winning style per subreddit feeds the next generation pass

It posts from your own Reddit account. Not a shared one.

Tech: TypeScript monorepo, no runtime dependencies in the core. The whole generation
engine is pure functions, which is why the CLI needs no database and no daemon.

The offline mode is a deterministic composer — no API key needed to evaluate whether the
output is structurally right, though you'll want a model for actual drafts.

Feedback welcome, especially: what dimension is missing from the style vector?
```

---

## 3. Product Hunt

**Tagline:** Ship code. We'll write the post.

**Description**

```
Upvote turns your commits, releases and learnings into authentic Reddit posts in your
own voice.

Reddit is the confirmed #1 growth channel for micro-SaaS. Upvote is the part that's
missing: not distribution, but writing.

Connect GitHub → pick your repos → train your voice on your past posts → get five
finished drafts with a subreddit, an hour and a first comment → approve → publish.

Every draft is scored 0-100 against a 29-dimension model of how you actually write.
Below 85 it's regenerated, not queued. That's the whole product.

Also included:
• subreddit rules parser that enforces no-self-promo, links-in-comments, flair and
  weekly limits before a draft reaches you
• best-time-to-post predictor per subreddit, learning from your own results
• post → click → signup → revenue attribution
• reply suggestions for comments on your published posts
• hard anti-spam guardrails: 1 post per subreddit per week, 3 per day, cooldown after
  a removal

Posts go out from YOUR Reddit account. Always.
```

**Comment replies (keep ready)**

- *"Doesn't this fight the whole point of writing in public?"* → The insight is still
  yours; the first draft just gets you to the keyboard with structure instead of a blank
  page. Every edit is yours, and the voice score tells you when an edit pushed it off
  your voice.
- *"Isn't this just ChatGPT with a prompt?"* → Try asking ChatGPT to sound like you
  across 29 measured dimensions and reject everything under 85. The gate is the product.
- *"Will it post without asking me?"* → No. Manual approval is on by default and I'd
  argue it should stay that way forever.

---

## 4. Twitter/X thread

```
1/ Reddit drove more growth for my last product than SEO + ads + social combined.
Then I tried to repeat it and found the real problem: I can't write.

I can't write. Not "busy." I genuinely don't enjoy turning a commit into a narrative,
and every attempt sounded like a press release.

So I built the tool I wanted.

2/ The problem with "write Reddit posts with AI" is that everyone can do it — and the
output always smells. Press-release fingerprints plus the confidence of a genius.

Generic copy gets downvoted. Matched copy gets upvoted. The whole game is the match.

3/ So Upvote measures 29 dimensions of how you write:
- sentence length + variance
- punctuation habits (em dashes or never?)
- formality, hedging, certainty
- emoji density, ALL-CAPS habits
- paragraph length
- the words you actually use
- the phrases you actually say

Then it scores every draft 0-100 against that.

4/ Under 85, it throws the draft away and regenerates.

I've never overridden the gate. The drafts it rejects are exactly the ones that would
have flopped.

5/ It also reads subreddit sidebars and turns them into rules it can check.

r/programming: no links, flair required.
Several subs: no self-promo, link goes in the comments.

So my drafts arrive already compliant.

6/ It suggests the hour each subreddit actually responds, and refuses to post more than
once a week in the same place.

1 post/week/subreddit. 3 posts/day total. 72h cooldown if something gets removed.

Because getting shadowbanned on an account you built over 10 years is expensive.

7/ It posts from YOUR Reddit account.

Not a shared one. A tool that posts from its own account will get every user
shadowbanned, and every one of them will blame the tool.

8/ The part I didn't expect: measuring my own writing changed how I write.

The profile told me my paragraphs average 19 words and I almost never ask questions in
posts. Both true. Neither conscious.

9/ Honest limitations:
- needs a body of past writing. My first drafts scored in the 70s on 6 samples. It says
  so instead of pretending
- offline mode is a deterministic composer — good for structure, not for posting
- the rules parser is regex. It handles what I've seen and tells you which rule matched

10/ $19/month.

I'd rather be judged on whether the drafts sound like me than on the feature list.

If it doesn't, tell me why — I read every comment and reply myself.
```

---

## 5. Blog post

**Title:** We analyzed 500 r/SaaS posts. Here's what actually gets upvoted.

**Structure** (write the real numbers from your own sample before publishing)

1. Method — 500 posts, which subreddits, the time window, how upvotes were bucketed.
2. The finding: upvote ratio, not raw upvotes, predicts longevity.
3. What the top decile has in common:
   - a concrete number in the first three lines
   - no link in the first paragraph
   - a first comment that answers the obvious follow-up
   - titles that name the problem, not the product
   - post length between 120 and 400 words
4. What the bottom quartile has in common: announcement voice, "excited to share",
   links above the fold, replies that are pure thanks.
5. The uncomfortable part: most posts that "failed" had good content. They failed on
   packaging.
6. What we built about it.

Replace every number with a measured one before publishing. This post is the strongest
possible demonstration of the product — do not ship it with placeholder statistics.

---

## 6. Demo video script (2 minutes)

| Time | Frame | Voiceover |
| --- | --- | --- |
| 0:00 | Terminal, `upvote onboard "shipped the ingest rewrite"` | "I'm not a content creator. This is the part I hate. So I built the thing." |
| 0:12 | Voice training output: quality score, signature phrases | "It read about 300 of my posts and comments, and worked out I average 8 words per sentence and almost never use em dashes." |
| 0:30 | Draft queue appears, 5 drafts | "Five drafts. Different angles of the same change." |
| 0:45 | Draft editor, voice score ticking as I type | "This is the part that matters. Every keystroke is re-scored against my voice. Ninety-three. It knows." |
| 1:05 | I make it worse on purpose, score drops to 79 | "So I break it on purpose. Seventy-nine. It refuses." |
| 1:20 | Subreddit suggestions with rules | "It read the sidebar. No links. Flair required. Already compliant." |
| 1:35 | Calendar view, scheduled slot | "Scheduled for Tuesday, 8pm. The hour that subreddit actually responds." |
| 1:45 | Analytics, attribution | "And then it tells me which post made the customer. Not the post that got the most upvotes — the one that closed." |
| 1:55 | Back to terminal | "I write the code. It writes the post. Nineteen bucks a month." |

## 7. Launch day order

1. Ship the blog post 24h early (the data post).
2. Launch on Product Hunt at 12:01am PT.
3. Post the r/SaaS meta post ~9am ET, from the founder account.
4. Submit to HN at 9:30am ET with the thread above.
5. Post the Twitter thread at 10am ET.
6. Reply to every comment yourself for the first 24h. Not a tool. You.