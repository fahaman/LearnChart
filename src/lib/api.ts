const API_URL = `${import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || (window.location.hostname === 'localhost' ? 'http://localhost:5005' : 'https://learnchart.onrender.com')}/api`;

export const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  return {
    "Content-Type": "application/json",
    Authorization: token ? `Bearer ${token}` : "",
  };
};

export const apiFetch = async (endpoint: string, options: RequestInit = {}) => {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: { ...getAuthHeaders(), ...options.headers },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "An error occurred");
  }

  return data;
};
