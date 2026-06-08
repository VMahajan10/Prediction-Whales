"use client";

import { useEffect, useState } from "react";

interface ToastProps {
  message: string;
  type: "success" | "error";
  visible: boolean;
}

export default function Toast({ message, type, visible }: ToastProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      const timer = setTimeout(() => setShow(false), 2000);
      return () => clearTimeout(timer);
    }
    setShow(false);
  }, [visible, message]);

  if (!show && !visible) return null;

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 rounded-lg px-4 py-3 text-sm font-medium text-white shadow-lg transition-opacity duration-300 ${
        show ? "opacity-100" : "opacity-0"
      } ${
        type === "success" ? "bg-pulse-yes" : "bg-red-500"
      }`}
    >
      {message}
    </div>
  );
}
