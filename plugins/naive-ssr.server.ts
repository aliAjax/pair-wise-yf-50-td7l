import { setup } from "@css-render/vue3-ssr";

export default defineNuxtPlugin((nuxtApp) => {
  // 服务端渲染时收集 naive-ui（css-render）产生的样式，避免组件在服务端直接操作 document
  const { collect } = setup(nuxtApp.vueApp);
  nuxtApp.hook("app:rendered", () => {
    const html = (nuxtApp.ssrContext as { html?: string } | undefined)?.html;
    if (!html) return;
    nuxtApp.ssrContext!.html = html.replace("</head>", () => `${collect()}</head>`);
  });
});
