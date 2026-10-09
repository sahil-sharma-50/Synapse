const header = document.querySelector(".header-space");
const updateHeader = () => header?.classList.toggle("is-scrolled", window.scrollY > 24);
updateHeader();
addEventListener("scroll", updateHeader, { passive: true });
addEventListener("pageshow", updateHeader);

const motion = matchMedia("(prefers-reduced-motion: reduce)");
if ("IntersectionObserver" in window && !motion.matches) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (!motion.matches)
          entry.target.animate(
            [
              { transform: "translateY(24px)", opacity: 0.65 },
              { transform: "translateY(0)", opacity: 1 },
            ],
            { duration: 650, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
          );
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll("[data-reveal]").forEach((element) => observer.observe(element));
  motion.addEventListener("change", () => {
    if (motion.matches) document.getAnimations().forEach((animation) => animation.finish());
  });
}
