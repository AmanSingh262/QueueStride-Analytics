import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Container,
  Paper,
  Typography,
  Box,
  Button,
  Grid,
  Card,
  CardContent,
  Alert,
  CircularProgress,
  Chip,
  IconButton,
  Tooltip,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Slider,
} from '@mui/material';
import {
  PlayArrow,
  Pause,
  CameraAlt,
  Upload,
  Refresh,
  Settings,
  Delete,
  Gesture,
} from '@mui/icons-material';
import Webcam from 'react-webcam';
import { useDropzone } from 'react-dropzone';
import { useQuery } from 'react-query';
import { cameraService, cvService, shelfService } from '../services/authService';
import { useSocket } from '../contexts/SocketContext';

const LiveMonitoringPage = () => {
  const [selectedCamera, setSelectedCamera] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(null);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [useWebcam, setUseWebcam] = useState(true);
  const [isVideoFile, setIsVideoFile] = useState(false);
  
  // Drawing ROI state variables
  const [drawingMode, setDrawingMode] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState(null); // { x, y, w, h }
  const [openAddShelfModal, setOpenAddShelfModal] = useState(false);
  const [newShelfName, setNewShelfName] = useState('');
  const [newShelfCategory, setNewShelfCategory] = useState('Chips');
  const [newShelfThreshold, setNewShelfThreshold] = useState(0.15);

  const webcamRef = useRef(null);
  const videoRef = useRef(null);
  const containerRef = useRef(null); // Reference to scale canvas coordinates
  const { connected } = useSocket();

  // Fetch cameras from backend
  const { data: cameras } = useQuery(
    'cameras',
    () => cameraService.getCameras(),
    {
      select: (response) => response.data,
    }
  );

  // Automatically select the first camera when loaded
  useEffect(() => {
    if (cameras && cameras.length > 0 && !selectedCamera) {
      setSelectedCamera(cameras[0].id);
    }
  }, [cameras, selectedCamera]);

  // Handle file drops (Images or Videos)
  const onDrop = useCallback((acceptedFiles) => {
    const file = acceptedFiles[0];
    if (file) {
      if (file.type.startsWith('video/')) {
        const videoURL = URL.createObjectURL(file);
        setCurrentFrame(videoURL);
        setIsVideoFile(true);
        setAnalysisResults([]);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          setCurrentFrame(reader.result);
          setIsVideoFile(false);
          processFrame(file);
        };
        reader.readAsDataURL(file);
      }
    }
  }, [selectedCamera]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.gif'],
      'video/*': ['.mp4', '.avi', '.mov', '.mkv']
    },
    multiple: false,
  });

  // Call the backend API to process a single frame
  const processFrame = async (imageFile) => {
    if (!selectedCamera) {
      return;
    }

    setProcessing(true);
    try {
      const response = await cvService.processFrame(selectedCamera, imageFile);
      setAnalysisResults(response.data.results || []);
    } catch (error) {
      console.error('Error processing frame:', error);
    } finally {
      setProcessing(false);
    }
  };

  // Capture frame from Webcam or Video element and send to backend
  const captureFrame = useCallback(() => {
    if (!selectedCamera) return;

    if (useWebcam && webcamRef.current) {
      const imageSrc = webcamRef.current.getScreenshot();
      if (!imageSrc) return;
      
      // Update local preview
      setCurrentFrame(imageSrc);
      
      // Convert to blob and upload
      fetch(imageSrc)
        .then(res => res.blob())
        .then(blob => {
          const file = new File([blob], 'webcam-capture.jpg', { type: 'image/jpeg' });
          processFrame(file);
        })
        .catch(err => console.error("Error capturing webcam frame:", err));
    } else if (!useWebcam && isVideoFile && videoRef.current) {
      const video = videoRef.current;
      if (video.readyState >= 2) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        canvas.toBlob((blob) => {
          if (blob) {
            const file = new File([blob], 'video-frame.jpg', { type: 'image/jpeg' });
            processFrame(file);
          }
        }, 'image/jpeg');
      }
    }
  }, [useWebcam, webcamRef, isVideoFile, videoRef, selectedCamera]);

  // Set up periodic monitoring loop (every 3 seconds) when streaming is active
  useEffect(() => {
    let intervalId = null;
    if (isStreaming && selectedCamera) {
      captureFrame();
      intervalId = setInterval(() => {
        captureFrame();
      }, 3000);
    }
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isStreaming, selectedCamera, captureFrame]);

  const startStreaming = () => {
    setIsStreaming(true);
  };

  const stopStreaming = () => {
    setIsStreaming(false);
    setAnalysisResults([]);
  };

  const autoDetectShelves = async () => {
    if (!currentFrame || !selectedCamera) {
      alert('Please capture a frame and select a camera first');
      return;
    }

    setProcessing(true);
    try {
      const blob = await fetch(currentFrame).then(res => res.blob());
      const file = new File([blob], 'frame.jpg', { type: 'image/jpeg' });
      
      const response = await cvService.detectShelves(selectedCamera, file);
      alert(`Detected ${response.data.detected_shelves.length} potential shelves. Regions will now be updated.`);
    } catch (error) {
      console.error('Error detecting shelves:', error);
      alert('Error detecting shelves');
    } finally {
      setProcessing(false);
    }
  };

  // Delete a shelf configuration
  const handleDeleteShelf = async (shelfId) => {
    if (!window.confirm('Are you sure you want to delete this shelf?')) return;
    
    setProcessing(true);
    try {
      await shelfService.deleteShelf(shelfId);
      // Instantly filter out from UI
      setAnalysisResults(prev => prev.filter(result => result.shelf_id !== shelfId));
      captureFrame(); // trigger re-evaluation
    } catch (error) {
      console.error('Error deleting shelf:', error);
      alert('Failed to delete shelf.');
    } finally {
      setProcessing(false);
    }
  };

  // Canvas drawing handlers
  const handleMouseDown = (e) => {
    if (!drawingMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setIsDrawing(true);
    setStartPos({ x, y });
    setCurrentRect({ x, y, w: 0, h: 0 });
  };

  const handleMouseMove = (e) => {
    if (!isDrawing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const w = x - startPos.x;
    const h = y - startPos.y;
    
    setCurrentRect({
      x: w < 0 ? x : startPos.x,
      y: h < 0 ? y : startPos.y,
      w: Math.abs(w),
      h: Math.abs(h),
    });
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    
    if (currentRect && currentRect.w > 10 && currentRect.h > 10) {
      setOpenAddShelfModal(true);
    } else {
      setCurrentRect(null);
    }
  };

  const handleSaveShelf = async () => {
    if (!newShelfName) {
      alert('Please enter a shelf name.');
      return;
    }
    
    const container = containerRef.current;
    if (!container || !currentRect) return;
    
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    // Scale coordinates to backend's standard 640x480 coordinate space
    const scaleX = 640 / containerWidth;
    const scaleY = 480 / containerHeight;
    
    const x = Math.round(currentRect.x * scaleX);
    const y = Math.round(currentRect.y * scaleY);
    const w = Math.round(currentRect.w * scaleX);
    const h = Math.round(currentRect.h * scaleY);
    
    const region = [x, y, w, h];
    
    setProcessing(true);
    try {
      await shelfService.createShelf({
        camera_id: selectedCamera,
        name: newShelfName,
        region: region,
        product_category: newShelfCategory,
        expected_stock_level: 'high',
        empty_threshold: newShelfThreshold
      });
      
      setOpenAddShelfModal(false);
      setNewShelfName('');
      setCurrentRect(null);
      setDrawingMode(false);
      
      // Process immediately to show the new shelf bounding box
      captureFrame();
    } catch (error) {
      console.error('Error creating shelf:', error);
      alert('Failed to save the shelf.');
    } finally {
      setProcessing(false);
    }
  };

  // Render overlay for mouse clicks and dragging
  const renderDrawingOverlay = () => {
    return (
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          cursor: drawingMode ? 'crosshair' : 'default',
          zIndex: 15,
          pointerEvents: drawingMode ? 'auto' : 'none',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {isDrawing && currentRect && (
          <div
            style={{
              position: 'absolute',
              left: `${currentRect.x}px`,
              top: `${currentRect.y}px`,
              width: `${currentRect.w}px`,
              height: `${currentRect.h}px`,
              border: '2.5px dashed #ff9800',
              backgroundColor: 'rgba(255, 152, 0, 0.25)',
              boxSizing: 'border-box',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    );
  };

  // Render AI bounding boxes over the live feed
  const renderBoundingBoxes = () => {
    if (analysisResults.length === 0 || !currentFrame) return null;
    
    // Scale reference coordinates relative to 640x480 standard aspect ratio
    const refWidth = 640;
    const refHeight = 480;

    return (
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      >
        {analysisResults.map((result, index) => {
          if (!result.region) return null;
          const [x, y, w, h] = result.region;
          
          const leftPct = (x / refWidth) * 100;
          const topPct = (y / refHeight) * 100;
          const widthPct = (w / refWidth) * 100;
          const heightPct = (h / refHeight) * 100;
          
          let color = '#4caf50'; // Green (STOCKED/HIGH)
          if (result.stock_level === 'EMPTY') color = '#f44336'; // Red
          else if (result.stock_level === 'LOW') color = '#ff9800'; // Orange
          else if (result.stock_level === 'MEDIUM') color = '#ffeb3b'; // Yellow
          
          return (
            <div
              key={index}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: `${topPct}%`,
                width: `${widthPct}%`,
                height: `${heightPct}%`,
                border: `3px solid ${color}`,
                boxSizing: 'border-box',
                transition: 'border-color 0.3s ease',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: '-18px',
                  left: '-3px',
                  backgroundColor: color,
                  color: '#000',
                  fontSize: '9px',
                  fontWeight: 'bold',
                  padding: '1px 4px',
                  whiteSpace: 'nowrap',
                  borderRadius: '2px',
                }}
              >
                {result.shelf_name} ({result.stock_level})
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom fontWeight="bold">
        Live AI Shelf Monitoring
      </Typography>

      {/* Connection Status */}
      <Alert 
        severity={connected ? 'success' : 'warning'} 
        sx={{ mb: 3 }}
      >
        {connected ? 'Connected to real-time AI monitoring system (YOLOv8 Active)' : 'Disconnected from monitoring system'}
      </Alert>

      <Grid container spacing={3}>
        {/* Camera Controls */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2, mb: 2 }}>
            <Typography variant="h6" gutterBottom fontWeight="bold">
              Camera Controls
            </Typography>
            
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Active AI Camera</InputLabel>
              <Select
                value={selectedCamera}
                onChange={(e) => setSelectedCamera(e.target.value)}
                label="Active AI Camera"
              >
                {cameras?.map((camera) => (
                  <MenuItem key={camera.id} value={camera.id}>
                    {camera.name} ({camera.location})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Box display="flex" gap={1} mb={2}>
              <Button
                variant={useWebcam ? 'contained' : 'outlined'}
                onClick={() => {
                  setUseWebcam(true);
                  setIsVideoFile(false);
                  setCurrentFrame(null);
                  stopStreaming();
                }}
                startIcon={<CameraAlt />}
                fullWidth
              >
                Webcam Feed
              </Button>
              <Button
                variant={!useWebcam ? 'contained' : 'outlined'}
                onClick={() => {
                  setUseWebcam(false);
                  setCurrentFrame(null);
                  stopStreaming();
                }}
                startIcon={<Upload />}
                fullWidth
              >
                Video / Image
              </Button>
            </Box>

            <Box display="flex" gap={1} mb={2}>
              <Button
                variant="contained"
                color={isStreaming ? 'error' : 'success'}
                onClick={isStreaming ? stopStreaming : startStreaming}
                startIcon={isStreaming ? <Pause /> : <PlayArrow />}
                disabled={!selectedCamera}
                fullWidth
              >
                {isStreaming ? 'Stop AI Monitor' : 'Start AI Monitor'}
              </Button>
            </Box>

            {/* Draw ROI Control */}
            <Box mb={2}>
              <Button
                variant={drawingMode ? 'contained' : 'outlined'}
                color={drawingMode ? 'warning' : 'primary'}
                onClick={() => {
                  setDrawingMode(!drawingMode);
                  setCurrentRect(null);
                }}
                startIcon={<Gesture />}
                disabled={!selectedCamera || !currentFrame}
                fullWidth
                sx={{
                  borderStyle: drawingMode ? 'solid' : 'dashed',
                  borderWidth: '2px',
                  fontWeight: 'bold',
                }}
              >
                {drawingMode ? 'Cancel Drawing' : 'Draw Shelf ROI'}
              </Button>
            </Box>

            <Box display="flex" gap={1}>
              <Button
                variant="outlined"
                onClick={autoDetectShelves}
                startIcon={<Settings />}
                disabled={!currentFrame || processing}
                fullWidth
              >
                Auto Detect
              </Button>
              <Tooltip title="Refresh Settings">
                <IconButton onClick={() => window.location.reload()}>
                  <Refresh />
                </IconButton>
              </Tooltip>
            </Box>
          </Paper>

          {/* Analysis Results */}
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom fontWeight="bold">
              Real-time Shelf Status
            </Typography>
            {processing && (
              <Box display="flex" alignItems="center" gap={2} mb={2}>
                <CircularProgress size={16} />
                <Typography variant="body2">AI Model processing frame...</Typography>
              </Box>
            )}
            {analysisResults.length > 0 ? (
              <Box>
                {analysisResults.map((result, index) => (
                  <Card key={index} sx={{ mb: 1.5, boxShadow: 1, borderLeft: `5px solid ${
                    result.stock_level === 'EMPTY' ? '#f44336' :
                    result.stock_level === 'LOW' ? '#ff9800' :
                    result.stock_level === 'MEDIUM' ? '#ffeb3b' : '#4caf50'
                  }` }}>
                    <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                      <Box display="flex" justifyContent="space-between" alignItems="center">
                        <Typography variant="subtitle2" fontWeight="bold">
                          {result.shelf_name}
                        </Typography>
                        <Box display="flex" alignItems="center" gap={1}>
                          <Chip
                            label={result.stock_level}
                            color={
                              result.stock_level === 'EMPTY' ? 'error' :
                              result.stock_level === 'LOW' ? 'warning' :
                              result.stock_level === 'MEDIUM' ? 'info' : 'success'
                            }
                            size="small"
                          />
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => handleDeleteShelf(result.shelf_id)}
                            tooltip="Delete Shelf ROI"
                          >
                            <Delete fontSize="small" />
                          </IconButton>
                        </Box>
                      </Box>
                      
                      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
                        Occupancy: {(result.occupancy_score * 100).toFixed(1)}%
                      </Typography>

                      {/* Display YOLO Recognized Items */}
                      {result.detected_items && result.detected_items.length > 0 && (
                        <Box display="flex" flexWrap="wrap" gap={0.5} sx={{ mt: 1 }}>
                          <Typography variant="body2" color="textSecondary" sx={{ mr: 1, display: 'flex', alignItems: 'center', fontSize: '0.75rem' }}>
                            Items:
                          </Typography>
                          {result.detected_items.map((item, idx) => (
                            <Chip 
                              key={idx} 
                              label={item} 
                              size="small" 
                              variant="outlined"
                              sx={{ 
                                fontSize: '0.7rem', 
                                height: '20px', 
                                backgroundColor: 'rgba(25, 118, 210, 0.08)',
                                borderColor: 'primary.light',
                                fontWeight: '500'
                              }} 
                            />
                          ))}
                        </Box>
                      )}

                      {result.needs_alert && (
                        <Alert severity="error" sx={{ mt: 1.5, py: 0, px: 1, fontSize: '0.75rem' }}>
                          {result.message}
                        </Alert>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </Box>
            ) : (
              <Typography color="textSecondary" variant="body2">
                No active shelves tracked. Start AI Monitor or draw a box to see results.
              </Typography>
            )}
          </Paper>
        </Grid>

        {/* Video/Image Display */}
        <Grid item xs={12} md={8}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom fontWeight="bold">
              Live AI Feed Analysis
            </Typography>
            
            <Box
              sx={{
                position: 'relative',
                border: '2px dashed #ccc',
                borderRadius: 1,
                minHeight: 400,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#1e1e1e',
                overflow: 'hidden',
              }}
            >
              {useWebcam ? (
                <Box 
                  ref={containerRef}
                  sx={{ position: 'relative', width: '100%', maxWidth: '640px', height: '480px' }}
                >
                  <Webcam
                    audio={false}
                    ref={webcamRef}
                    screenshotFormat="image/jpeg"
                    width="100%"
                    height="100%"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                    }}
                  />
                  {isStreaming && (
                    <Box
                      sx={{
                        position: 'absolute',
                        top: 10,
                        left: 10,
                        backgroundColor: 'rgba(244, 67, 54, 0.9)',
                        color: 'white',
                        padding: '4px 8px',
                        borderRadius: 1,
                        fontSize: '0.75rem',
                        fontWeight: 'bold',
                        zIndex: 20,
                        animation: 'pulse 1.5s infinite',
                        '@keyframes pulse': {
                          '0%': { opacity: 0.6 },
                          '50%': { opacity: 1 },
                          '100%': { opacity: 0.6 }
                        }
                      }}
                    >
                      🔴 AI MONITOR ACTIVE
                    </Box>
                  )}
                  {drawingMode && (
                    <Box
                      sx={{
                        position: 'absolute',
                        top: 10,
                        right: 10,
                        backgroundColor: 'rgba(255, 152, 0, 0.95)',
                        color: 'black',
                        padding: '4px 8px',
                        borderRadius: 1,
                        fontSize: '0.75rem',
                        fontWeight: 'bold',
                        zIndex: 20,
                      }}
                    >
                      📐 DRAW MODE: Drag box on stream
                    </Box>
                  )}
                  {renderBoundingBoxes()}
                  {renderDrawingOverlay()}
                </Box>
              ) : (
                <Box
                  sx={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 400,
                    position: 'relative',
                  }}
                >
                  {currentFrame ? (
                    <Box 
                      ref={containerRef}
                      sx={{ position: 'relative', width: '100%', maxWidth: '640px', height: '480px' }}
                    >
                      {isVideoFile ? (
                        <video
                          ref={videoRef}
                          src={currentFrame}
                          controls
                          autoPlay
                          loop
                          muted
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                          }}
                        />
                      ) : (
                        <img
                          src={currentFrame}
                          alt="Uploaded frame"
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                          }}
                        />
                      )}
                      {drawingMode && (
                        <Box
                          sx={{
                            position: 'absolute',
                            top: 10,
                            right: 10,
                            backgroundColor: 'rgba(255, 152, 0, 0.95)',
                            color: 'black',
                            padding: '4px 8px',
                            borderRadius: 1,
                            fontSize: '0.75rem',
                            fontWeight: 'bold',
                            zIndex: 20,
                          }}
                        >
                          📐 DRAW MODE: Drag box on image/video
                        </Box>
                      )}
                      {renderBoundingBoxes()}
                      {renderDrawingOverlay()}
                    </Box>
                  ) : (
                    <Box
                      {...getRootProps()}
                      sx={{
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        minHeight: 400,
                      }}
                    >
                      <input {...getInputProps()} />
                      <Box textAlign="center" sx={{ color: '#aaa' }}>
                        <Upload sx={{ fontSize: 48, color: '#666', mb: 2 }} />
                        <Typography>
                          {isDragActive
                            ? 'Drop files here...'
                            : 'Drag & drop an image or video file here, or click to select'}
                        </Typography>
                      </Box>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* Configure Shelf Modal */}
      <Dialog 
        open={openAddShelfModal} 
        onClose={() => { setOpenAddShelfModal(false); setCurrentRect(null); }} 
        maxWidth="xs" 
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 'bold' }}>Configure Shelf Region</DialogTitle>
        <DialogContent dividers>
          <TextField
            autoFocus
            margin="dense"
            label="Shelf Name"
            fullWidth
            variant="outlined"
            value={newShelfName}
            onChange={(e) => setNewShelfName(e.target.value)}
            placeholder="e.g. Snack Shelf C1"
            sx={{ mb: 3 }}
          />
          
          <FormControl fullWidth sx={{ mb: 3 }}>
            <InputLabel>Product Category</InputLabel>
            <Select
              value={newShelfCategory}
              onChange={(e) => setNewShelfCategory(e.target.value)}
              label="Product Category"
            >
              <MenuItem value="Chips">Chips packets / Bags</MenuItem>
              <MenuItem value="Beverages">Beverages / Bottles</MenuItem>
              <MenuItem value="Snacks">Snacks / Food</MenuItem>
              <MenuItem value="Boxed Items">Boxed / Packaged Items</MenuItem>
              <MenuItem value="General Products">General Products</MenuItem>
            </Select>
          </FormControl>
          
          <Typography gutterBottom variant="subtitle2" color="textSecondary">
            Empty Alert Threshold: {Math.round(newShelfThreshold * 100)}%
          </Typography>
          <Slider
            value={newShelfThreshold}
            min={0.05}
            max={0.5}
            step={0.05}
            onChange={(e, val) => setNewShelfThreshold(val)}
            valueLabelDisplay="auto"
            valueLabelFormat={(val) => `${Math.round(val * 100)}%`}
          />
          <Typography variant="caption" color="textSecondary" display="block" sx={{ mt: 1 }}>
            Alerts will trigger when shelf occupancy falls below this percentage.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setOpenAddShelfModal(false); setCurrentRect(null); }} color="inherit">
            Cancel
          </Button>
          <Button onClick={handleSaveShelf} variant="contained" color="primary" disabled={!newShelfName}>
            Save Shelf
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default LiveMonitoringPage;
