import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { useSnackbar } from 'notistack';

const SocketContext = createContext();

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};

export const SocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const { user, token } = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  useEffect(() => {
    if (user && token) {
      // Initialize native WebSocket connection
      const apiURL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
      // If apiURL is '/' (relative path), construct the websocket URL relative to the window location
      const baseSocketURL = apiURL === '/' 
        ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
        : apiURL.replace(/^http/, 'ws');
        
      const socketURL = `${baseSocketURL}/ws`;
      
      console.log('Connecting to WebSocket:', socketURL);
      const ws = new WebSocket(socketURL);
      
      // Store event listeners
      const listeners = {};
      
      const mockSocket = {
        on: (event, callback) => {
          if (!listeners[event]) {
            listeners[event] = [];
          }
          listeners[event].push(callback);
        },
        emit: (event, data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event, data }));
          }
        },
        close: () => {
          ws.close();
        }
      };

      ws.onopen = () => {
        console.log('WebSocket connected');
        setConnected(true);
        if (listeners['connect']) {
          listeners['connect'].forEach(cb => cb());
        }
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setConnected(false);
        if (listeners['disconnect']) {
          listeners['disconnect'].forEach(cb => cb());
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Standard FastAPI WebSocket alerts send JSON like {"type": "alert", ...}
          // We trigger callbacks registered under the event name (e.g. data.type)
          if (data && data.type && listeners[data.type]) {
            listeners[data.type].forEach(cb => cb(data));
          }
        } catch (e) {
          console.error("Failed to parse WebSocket message:", e);
        }
      };

      // Register callbacks defined below
      mockSocket.on('alert', (alertData) => {
        console.log('New alert received:', alertData);
        setAlerts(prev => [alertData, ...prev.slice(0, 99)]);
        enqueueSnackbar(
          `${alertData.title || 'Stock Alert'}: ${alertData.message}`,
          {
            variant: alertData.priority === 'HIGH' ? 'error' : 'warning',
            autoHideDuration: alertData.priority === 'HIGH' ? 10000 : 5000,
          }
        );
      });

      mockSocket.on('camera_status', (data) => {
        console.log('Camera status update:', data);
      });

      mockSocket.on('shelf_status', (data) => {
        console.log('Shelf status update:', data);
      });

      setSocket(mockSocket);

      return () => {
        ws.close();
      };
    }
  }, [user, token, enqueueSnackbar]);

  const sendMessage = (event, data) => {
    if (socket && connected) {
      socket.emit(event, data);
    }
  };

  const clearAlerts = () => {
    setAlerts([]);
  };

  const markAlertAsRead = (alertId) => {
    setAlerts(prev => 
      prev.map(alert => 
        alert.id === alertId ? { ...alert, read: true } : alert
      )
    );
  };

  const value = {
    socket,
    connected,
    alerts,
    sendMessage,
    clearAlerts,
    markAlertAsRead,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};
