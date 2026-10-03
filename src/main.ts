import { createApp } from 'vue';
import { createWebHistory } from 'vue-router';
import './assets/styles.css';
import App from './App.vue';
import { createAppRouter } from './router';

createApp(App).use(createAppRouter(createWebHistory())).mount('#app');
