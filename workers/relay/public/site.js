// Scroll reveal is pure CSS (animation-timeline: view() in styles.css) — no
// JS observer, so content can never be left invisible by missed events.

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
