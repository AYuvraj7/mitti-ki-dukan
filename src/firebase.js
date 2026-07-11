import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
 
const firebaseConfig = {
  apiKey: "AIzaSyAke8HI25KhI3UX4ErMBat00t_s-F3WBeE",
  authDomain: "mitti-ki-dukan.firebaseapp.com",
  projectId: "mitti-ki-dukan",
  storageBucket: "mitti-ki-dukan.firebasestorage.app",
  messagingSenderId: "303441413934",
  appId: "1:303441413934:web:39b727b96133d1f0d49cbf",
};
 
const app = initializeApp(firebaseConfig);
 
export const db = getFirestore(app);
export const auth = getAuth(app);