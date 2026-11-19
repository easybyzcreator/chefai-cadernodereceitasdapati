
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAUca0f7kWLKcE-9jVzXv_X07VYa0DCAME",
  authDomain: "app-chefai-patitour.firebaseapp.com",
  projectId: "app-chefai-patitour",
  storageBucket: "app-chefai-patitour.firebasestorage.app",
  messagingSenderId: "848476728710",
  appId: "1:848476728710:web:da2c28c59508b530665007",
  measurementId: "G-RMWJ38ZFZC"
};

const app = initializeApp(firebaseConfig);

let dbInstance: Firestore;
try {
  dbInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
} catch {
  dbInstance = getFirestore(app);
}

export const db = dbInstance;
