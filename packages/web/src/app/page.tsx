import Link from 'next/link';
import { pricingTable } from '@upvote/core';
import { DraftPreview } from '@/components/landing/draft-preview';

const PRICING = pricingTable();

const PAIN = [
  {
    quote: "I'm not a content creator and this is kicking my ass.",
    attribution: 'a founder, in the r/SaaS thread that started this',
  },
  {
    quote: 'Reddit drove more growth than SEO, ads and social combined. We closed a sale in four days.',
    attribution: 'micro-SaaS founder, four offers on the table',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Connect GitHub',
    body: 'Pick the repos you ship in. Upvote watches for releases, merged shippable PRs and closed bugs — and ignores the typo fixes, lockfile bumps and CI edits.',
  },
  {
    n: '02',
    title: 'Train your voice',
    body: 'Upvote reads your past posts, comments, READMEs and commit messages. In about a minute it knows your sentence length, your punctuation habits, and the words you actually use.',
  },
  {
    n: '03',
    title: 'Review, approve, post',
    body: 'Five drafts land in your queue with a subreddit, an hour and a voice score. Nothing goes out without you.',
  },
];

const FEATURES = [
  {
    title: 'Voice matching',
    body: 'Every draft is scored 0-100 against your profile across 29 measured dimensions. Below 85 it is regenerated, not published. Generic copy gets downvoted; matched copy gets upvoted.',
  },
  {
    title: 'Subreddit rules, parsed',
    body: 'Sidebars are read and turned into machine-checkable rules: no self-promo, links in comments only, flair required, weekly post limits. Drafts that break a rule are blocked before they reach you.',
  },
  {
    title: 'Best hour per subreddit',
    body: 'A time predictor per subreddit, blended with your own results once you have history. No more posting at 4am because it was convenient.',
  },
  {
    title: 'Post to signup attribution',
    body: 'Every post link carries a tracked URL. See which post produced the signup and the dollar, not just the upvote.',
  },
  {
    title: 'Reply suggestions',
    body: 'When comments arrive, Upvote drafts replies in your voice and waits for you to post them.',
  },
  {
    title: 'A learning loop',
    body: 'Which style wins in which subreddit, and which hour works for you, feeds back into the next batch of drafts. It gets sharper the longer you use it.',
  },
];

const ANTI_SPAM = [
  'Max 1 post per subreddit per week',
  'Max 3 posts per day total',
  'Blocklist for subreddits you never want touched',
  'Cooldown after a removal, before it tries again',
  'Manual approval on by default, always',
  'Posts go out from your Reddit account, never ours',
];

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <header className="mb-16 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Now accepting Pro users · $19/mo
        </div>
        <h1 className="mx-auto max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          Ship code.
          <br />
          <span className="text-muted-foreground">We&rsquo;ll write the post.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-muted-foreground">
          Reddit is the confirmed number-one growth channel for micro-SaaS. Upvote watches your repos,
          learns how you write, and drafts the post in your voice — then publishes it at the hour that
          subreddit actually responds.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/onboarding"
            className="inline-flex h-11 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Start free — 3 drafts a month
          </Link>
          <a
            href="#pricing"
            className="inline-flex h-11 items-center rounded-md border px-6 text-sm font-medium transition-colors hover:bg-accent"
          >
            See pricing
          </a>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Connect GitHub, see five drafts in 60 seconds.</p>
      </header>

      <DraftPreview />

      <section className="mt-24 grid gap-6 sm:grid-cols-2">
        {PAIN.map((item) => (
          <figure key={item.quote} className="rounded-lg border bg-card p-6">
            <blockquote className="text-pretty text-lg">&ldquo;{item.quote}&rdquo;</blockquote>
            <figcaption className="mt-3 text-sm text-muted-foreground">— {item.attribution}</figcaption>
          </figure>
        ))}
      </section>

      <section className="mt-24">
        <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.n} className="rounded-lg border bg-card p-6">
              <div className="font-mono text-sm text-muted-foreground">{step.n}</div>
              <h3 className="mt-2 font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-24">
        <h2 className="text-3xl font-semibold tracking-tight">The voice engine is the product</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Anyone can ask a language model to write a Reddit post. Almost nobody can write one that sounds
          like a person instead of a press release. That is the whole gap, and Upvote is built around it.
        </p>
        <div className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-lg border bg-card p-5">
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-24 rounded-lg border bg-card p-8">
        <h2 className="text-2xl font-semibold tracking-tight">It will not spam your account</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Reddit punishes low-effort self-promotion, and a shadowban costs an account you built over years.
          The guardrails are on whether or not you ask for them.
        </p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {ANTI_SPAM.map((rule) => (
            <li key={rule} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 text-emerald-600">&#10003;</span>
              {rule}
            </li>
          ))}
        </ul>
      </section>

      <section id="pricing" className="mt-24">
        <h2 className="text-center text-3xl font-semibold tracking-tight">Pricing</h2>
        <p className="mt-3 text-center text-muted-foreground">
          One founder, one Reddit account. Upgrade when Reddit starts working.
        </p>
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {PRICING.map((plan) => (
            <div
              key={plan.id}
              className={
                plan.highlighted
                  ? 'relative rounded-lg border-2 border-primary bg-card p-6 shadow-md'
                  : 'rounded-lg border bg-card p-6'
              }
            >
              {plan.highlighted && (
                <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
                  Most founders pick this
                </span>
              )}
              <h3 className="font-semibold">{plan.name}</h3>
              <div className="mt-2 text-3xl font-semibold">{plan.price}</div>
              <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
              <ul className="mt-6 space-y-2 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <span className="mt-0.5 text-muted-foreground">&#10003;</span>
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/onboarding"
                className={
                  plan.highlighted
                    ? 'mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
                    : 'mt-6 inline-flex h-10 w-full items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-accent'
                }
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-24 rounded-lg border bg-card p-8 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Your next commit is a post</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Connect GitHub, train your voice, and look at five finished drafts before your coffee gets cold.
        </p>
        <Link
          href="/onboarding"
          className="mt-6 inline-flex h-11 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Start free
        </Link>
      </section>

      <footer className="mt-24 border-t pt-8 text-sm text-muted-foreground">
        <div className="flex flex-col justify-between gap-4 sm:flex-row">
          <p>Upvote — Reddit growth on autopilot for developers.</p>
          <div className="flex gap-6">
            <Link href="/docs" className="hover:text-foreground">
              Docs
            </Link>
            <Link href="/pricing" className="hover:text-foreground">
              Pricing
            </Link>
            <a href="https://github.com" className="hover:text-foreground">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}