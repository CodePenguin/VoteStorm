import { createRouter, type RouterHistory } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** Views that draw their own footer (e.g. the projector results screen) opt out of the shared one. */
    ownFooter?: boolean;
    /** Page title, shown in the tab and read by screen readers on navigation. */
    title?: string;
  }
}

export const routes = [
  { path: '/', name: 'landing', component: () => import('./views/LandingView.vue') },
  { path: '/presenter', name: 'presenter', component: () => import('./views/PresenterView.vue'), meta: { title: 'Presenter' } },
  { path: '/vote/:stormCode', name: 'vote', component: () => import('./views/VoteView.vue'), meta: { title: 'Vote' } },
  { path: '/results', name: 'results', component: () => import('./views/ResultsView.vue'), meta: { ownFooter: true, title: 'Results' } },
  { path: '/storms', name: 'storms', component: () => import('./views/StormsView.vue'), meta: { title: 'Your Storms' } },
  { path: '/license', name: 'license', component: () => import('./views/LicenseView.vue'), meta: { title: 'License' } },
  { path: '/privacy', name: 'privacy', component: () => import('./views/PrivacyView.vue'), meta: { title: 'Privacy' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue'), meta: { title: 'Page not found' } },
];

export function createAppRouter(history: RouterHistory) {
  const router = createRouter({ history, routes });
  router.afterEach((to) => {
    document.title = to.meta.title ? `${to.meta.title} \u00b7 VoteStorm` : 'VoteStorm';
  });
  return router;
}
