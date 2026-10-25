// A minimal custom widget (docs/dashboard.md, "Custom widgets"): options from the config, live data from its
// source, colours from the theme. Use it with:
// { "type": "custom", "title": "Hello", "module": "widgets/hello.js", "source": "health", "options": { "greeting": "hej" } }
export function mount(root, ctx) {
  root.innerHTML = `<style>
    p { margin: 0; font: 700 28px var(--font); color: var(--primary) }
    small { color: var(--muted) }
  </style><p></p><small></small>`
  const show = data => {
    root.querySelector('p').textContent = `${ctx.options.greeting ?? 'hello'}: ${data?.connected ?? 0} sessions`
    root.querySelector('small').textContent = `updated ${new Date().toLocaleTimeString()}`
  }
  show(ctx.data)
  return { update: show }
}
