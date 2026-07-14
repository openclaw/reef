// Scroll reveal is pure CSS (animation-timeline: view() in styles.css) — no
// JS observer, so content can never be left invisible by missed events.

// Depth gauge: page progress as metres of descent, homepage only.
if (document.querySelector(".hero")) {
  const gauge = document.createElement("div");
  gauge.className = "depth";
  gauge.setAttribute("aria-hidden", "true");
  const readout = document.createElement("span");
  gauge.append(readout);
  document.body.append(gauge);

  // Full ocean: the footer bottoms out at Challenger Deep.
  const zone = (m) =>
    m >= 10800
      ? "CHALLENGER DEEP"
      : m >= 6000
        ? "HADAL"
        : m >= 4000
          ? "ABYSS"
          : m >= 1000
            ? "MIDNIGHT"
            : m >= 200
              ? "TWILIGHT"
              : "SURFACE";
  let last = "";
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    // clamp both ends: Safari reports negative scrollY during elastic overscroll
    const ratio = max > 0 ? Math.min(Math.max(window.scrollY / max, 0), 1) : 0;
    const metres = Math.round(ratio * 1092) * 10;
    const text = `${String(metres).padStart(4, "0")} M · ${zone(metres)}`;
    if (text !== last) {
      last = text;
      readout.textContent = text;
    }
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  update();
}

// The tab seals its envelope while you're away.
const baseTitle = document.title;
document.addEventListener("visibilitychange", () => {
  document.title = document.hidden ? "◆ channel sealed — Reef" : baseTitle;
});

// For the crew that opens the hatch.
console.info(
  "%c REEF %c channel monitor: no eavesdroppers detected.\n%cE2E encrypted · operator-blind · pinned guards at both ends · https://reefwire.ai/docs/",
  "background:#ff6f4d;color:#04161b;font-weight:700;border-radius:3px;padding:2px 6px;",
  "color:#7fd8c4;font-weight:600;",
  "color:#5f827c;",
);

const signupForm = document.querySelector("[data-signup-form]");

if (signupForm instanceof HTMLFormElement) {
  const status = signupForm.querySelector("[data-signup-status]");
  const button = signupForm.querySelector("button[type='submit']");

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!(button instanceof HTMLButtonElement) || !(status instanceof HTMLElement)) return;
    const data = new FormData(signupForm);
    const email = String(data.get("email") ?? "").trim();
    button.disabled = true;
    button.textContent = "Sending…";
    status.className = "form-status";
    status.textContent = "";

    try {
      const response = await fetch("/v1/auth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        if (response.status === 429) throw new Error("rate_limit");
        if (response.status === 400) throw new Error("invalid_email");
        throw new Error("send_failed");
      }
      signupForm.innerHTML = `<div class="signup-sent"><span aria-hidden="true">✓</span><div><h3>Check your email</h3><p>We sent a short-lived Reef sign-in link to <strong></strong>.</p></div></div>`;
      const address = signupForm.querySelector("strong");
      if (address) address.textContent = email;
    } catch (error) {
      status.classList.add("error");
      status.textContent = error instanceof Error && error.message === "rate_limit"
        ? "Too many sign-in attempts. Wait a little, then try again."
        : error instanceof Error && error.message === "invalid_email"
          ? "Enter a valid email address."
          : "We could not send the link. Please try again.";
      button.disabled = false;
      button.innerHTML = "Get started <span>→</span>";
    }
  });
}
