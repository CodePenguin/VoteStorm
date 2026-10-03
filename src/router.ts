import { createRouter, type RouterHistory } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** Views that draw their own footer (e.g. the projector results screen) opt out of the shared one. */
    ownFooter?: boolean;
  }
}

export const routes = [
  { path: '/', name: 'landing', component: () => import('./views/LandingView.vue') },
  { path: '/presenter/:adminKey?', name: 'presenter', component: () => import('./views/PresenterView.vue') },
  { path: '/vote/:roomCode', name: 'vote', component: () => import('./views/VoteView.vue') },
  { path: '/results/:resultsKey', name: 'results', component: () => import('./views/ResultsView.vue'), meta: { ownFooter: true } },
  { path: '/license', name: 'license', component: () => import('./views/LicenseView.vue') },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue') },
];

export function createAppRouter(history: RouterHistory) {
  return createRouter({ history, routes });
}
