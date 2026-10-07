<template>
  <main class="container privacy-page">
    <RouterLink to="/" class="muted back">&larr; Back</RouterLink>
    <h1>Privacy</h1>
    <p class="lead">
      VoteStorm is built to collect as little as possible. This page says what is stored, who handles it, and how long it stays.
    </p>

    <h2>When you vote</h2>
    <ul>
      <li>Your answers are stored with the Storm. There is no name, email address or account.</li>
      <li>
        A random device ID is created in your browser the first time you use VoteStorm. It keeps one answer per question for each device and lets you
        change your answer. It is not linked to who you are.
      </li>
    </ul>

    <h2>When you present</h2>
    <p>
      A Storm holds its questions and settings, and is controlled by a secret link. Whoever has that link can run the Storm, so keep it private.
      If you add a license, it is saved in your browser.
    </p>

    <h2>Your IP address</h2>
    <p>
      Your address is used briefly to slow down abuse. Only a one-way hash of it is stored, in short-lived counters that routine cleanup removes. It is
      not used to build a profile of you.
    </p>

    <h2>Browser storage</h2>
    <p>
      VoteStorm sets no cookies. It uses your browser&rsquo;s local storage for your device ID, which questions you have answered and what you chose,
      the presenter&rsquo;s view setting, and a license if you added one. Clearing your site data removes all of it, and you will appear as a new device.
    </p>

    <h2>Who handles your data</h2>
    <ul>
      <li><strong>Netlify</strong> hosts the site and keeps its own server logs, which include IP addresses.</li>
      <li><strong>Turso</strong> hosts the database that stores Storms, questions and votes.</li>
      <li><strong>Ably</strong> delivers live updates. It sees your device ID and IP address while your page is connected.</li>
    </ul>
    <p>VoteStorm does not use analytics, advertising or tracking. These providers keep their own logs under their own policies.</p>

    <h2>How long it is kept</h2>
    <p>
      A Storm, its questions and all of its votes are deleted automatically after a period with no activity (24 hours unless the presenter&rsquo;s license
      says otherwise), or straight away when the presenter deletes the Storm.
    </p>

    <h2>Questions</h2>
    <p>Get in touch through <a href="https://codepenguin.com" rel="noopener noreferrer">codepenguin.com</a>.</p>

    <p class="muted note">This is a plain-language summary of how VoteStorm works. It is not legal advice.</p>
  </main>
</template>

<style>
.privacy-page { padding-top: 28px; padding-bottom: 48px; }
.privacy-page .back { display: inline-block; margin-bottom: 12px; font-size: .9rem; }
.privacy-page .lead { color: var(--text-muted); margin-top: 10px; }
.privacy-page h2 { font-size: 1.1rem; margin-top: 28px; margin-bottom: 8px; }
.privacy-page ul { margin: 0; padding-left: 1.2rem; display: grid; gap: 8px; }
.privacy-page p { line-height: 1.55; }
.privacy-page p a, .privacy-page li a { text-decoration: underline; }
.privacy-page .note { margin-top: 32px; font-size: .85rem; }
</style>
