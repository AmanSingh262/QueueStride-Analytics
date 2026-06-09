import cv2
import numpy as np
from typing import List, Dict, Any
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

class CVProcessor:
    def __init__(self):
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=500, varThreshold=16, detectShadows=True
        )
        self.alert_cooldown = {}
        self.alert_duration = 300  # 5 minutes
        
        # Initialize YOLOv8
        self.yolo_enabled = False
        try:
            from ultralytics import YOLO
            # Load yolov8n model (downloads automatically if not locally cached)
            self.model = YOLO('yolov8n.pt')
            self.yolo_enabled = True
            logger.info("YOLOv8 initialized successfully.")
        except Exception as e:
            logger.error(f"Failed to initialize YOLOv8: {str(e)}. Falling back to traditional CV.")

        # Mapping COCO dataset classes to store product terms
        self.coco_to_store_map = {
            'bottle': 'Beverage',
            'wine glass': 'Beverage',
            'cup': 'Beverage',
            'handbag': 'Chips Packet/Bag',
            'backpack': 'Chips Packet/Bag',
            'sandwich': 'Snack/Food',
            'banana': 'Snack/Food',
            'apple': 'Snack/Food',
            'orange': 'Snack/Food',
            'broccoli': 'Snack/Food',
            'carrot': 'Snack/Food',
            'hot dog': 'Snack/Food',
            'pizza': 'Snack/Food',
            'donut': 'Snack/Food',
            'cake': 'Snack/Food',
            'book': 'Boxed Item',
            'cell phone': 'Boxed Item',
            'toothbrush': 'Product',
            'clock': 'Product',
            'vase': 'Product',
            'scissors': 'Product',
            'teddy bear': 'Product',
            'hair drier': 'Product'
        }

        # Background or non-product classes to exclude
        self.excluded_classes = {
            'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
            'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'cat', 'dog', 'horse',
            'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'tie', 'suitcase', 'frisbee', 'skis',
            'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
            'tennis racket', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop',
            'mouse', 'remote', 'keyboard', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator'
        }
        
    def detect_shelves(self, frame: np.ndarray) -> List[Dict[str, Any]]:
        """Automatically detect shelf regions using edge detection and contours"""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Apply Gaussian blur
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        
        # Edge detection
        edges = cv2.Canny(blurred, 50, 150)
        
        # Find contours
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        potential_shelves = []
        
        for contour in contours:
            # Calculate contour area and bounding rectangle
            area = cv2.contourArea(contour)
            if area < 5000:  # Filter small contours
                continue
                
            x, y, w, h = cv2.boundingRect(contour)
            
            # Filter based on aspect ratio (shelves are typically wider than tall)
            aspect_ratio = w / h
            if aspect_ratio > 1.5 and w > 100 and h > 50:
                potential_shelves.append({
                    'region': [x, y, w, h],
                    'area': area,
                    'aspect_ratio': aspect_ratio,
                    'confidence': min(area / 10000, 1.0)
                })
        
        return potential_shelves
    
    def analyze_shelf_occupancy(self, frame: np.ndarray, shelf_region: List[int]) -> float:
        """Analyze shelf occupancy using multiple computer vision techniques"""
        x, y, w, h = shelf_region
        
        # Validate region
        if x < 0 or y < 0 or x + w > frame.shape[1] or y + h > frame.shape[0]:
            return 0.0
            
        shelf_roi = frame[y:y+h, x:x+w]
        
        if shelf_roi.size == 0:
            return 0.0
        
        # Convert to different color spaces for analysis
        gray_roi = cv2.cvtColor(shelf_roi, cv2.COLOR_BGR2GRAY)
        
        # Method 1: Edge density analysis
        edges = cv2.Canny(gray_roi, 50, 150)
        edge_density = np.sum(edges > 0) / (edges.shape[0] * edges.shape[1])
        
        # Method 2: Color variance analysis
        color_variance = np.var(gray_roi)
        
        # Method 3: Histogram analysis
        hist = cv2.calcHist([gray_roi], [0], None, [256], [0, 256])
        hist_variance = np.var(hist)
        
        # Method 4: Background subtraction
        try:
            fg_mask = self.bg_subtractor.apply(shelf_roi)
            foreground_ratio = np.sum(fg_mask > 0) / (fg_mask.shape[0] * fg_mask.shape[1])
        except:
            foreground_ratio = 0.0
        
        # Method 5: Contour analysis
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour_count = len(contours)
        contour_score = min(contour_count / 20.0, 1.0)
        
        # Combine metrics to determine occupancy
        occupancy_score = (
            edge_density * 0.25 +
            min(color_variance / 1000, 1.0) * 0.25 +
            min(hist_variance / 1000000, 1.0) * 0.2 +
            foreground_ratio * 0.15 +
            contour_score * 0.15
        )
        
        return min(occupancy_score, 1.0)
    
    def classify_stock_level(self, occupancy_score: float, empty_threshold: float = 0.15) -> str:
        """Classify stock level based on occupancy score"""
        if occupancy_score < empty_threshold:
            return "EMPTY"
        elif occupancy_score < 0.3:
            return "LOW"
        elif occupancy_score < 0.7:
            return "MEDIUM"
        else:
            return "HIGH"
    
    def should_alert(self, shelf_id: int, occupancy_score: float, empty_threshold: float = 0.15) -> bool:
        """Determine if an alert should be sent considering cooldown"""
        if occupancy_score >= empty_threshold:
            return False
            
        current_time = datetime.now()
        
        # Check cooldown
        if shelf_id in self.alert_cooldown:
            time_diff = (current_time - self.alert_cooldown[shelf_id]).total_seconds()
            if time_diff < self.alert_duration:
                return False
        
        # Update cooldown
        self.alert_cooldown[shelf_id] = current_time
        return True
    
    def process_frame(self, frame: np.ndarray, shelves: List[Any]) -> List[Dict[str, Any]]:
        """Process a frame and analyze all shelves using YOLOv8 and traditional CV"""
        results = []
        
        # Run YOLOv8 on the whole frame first
        yolo_detections = []
        if self.yolo_enabled:
            try:
                yolo_results = self.model(frame, verbose=False)
                for r in yolo_results:
                    boxes = r.boxes
                    for box in boxes:
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        conf = float(box.conf[0])
                        cls_id = int(box.cls[0])
                        cls_name = self.model.names[cls_id]
                        
                        if cls_name not in self.excluded_classes and conf > 0.25:
                            yolo_detections.append({
                                'box': [x1, y1, x2 - x1, y2 - y1],
                                'center': [(x1 + x2) / 2, (y1 + y2) / 2],
                                'class_name': cls_name,
                                'confidence': conf,
                                'display_name': self.coco_to_store_map.get(cls_name, cls_name.capitalize())
                            })
            except Exception as e:
                logger.error(f"YOLOv8 inference error: {str(e)}")
        
        for shelf in shelves:
            try:
                shelf_region = shelf.region
                sx, sy, sw, sh = shelf_region
                
                # Check which YOLO detections are on this shelf
                shelf_products = []
                for det in yolo_detections:
                    cx, cy = det['center']
                    # Check if center point of the object is within the shelf bounding box
                    if sx <= cx <= sx + sw and sy <= cy <= sy + sh:
                        shelf_products.append(det)
                
                num_products = len(shelf_products)
                traditional_occupancy = self.analyze_shelf_occupancy(frame, shelf_region)
                
                if self.yolo_enabled:
                    if num_products > 0:
                        # YOLO occupancy starts at 0.5 and increases with count
                        yolo_occupancy = min(0.5 + 0.25 * num_products, 1.0)
                        occupancy_score = max(yolo_occupancy, traditional_occupancy)
                    else:
                        # If YOLO doesn't detect specific class, use traditional CV
                        occupancy_score = traditional_occupancy
                else:
                    occupancy_score = traditional_occupancy
                
                stock_level = self.classify_stock_level(occupancy_score, shelf.empty_threshold)
                
                # Determine if alert is needed
                needs_alert = self.should_alert(shelf.id, occupancy_score, shelf.empty_threshold)
                
                # Determine priority
                if occupancy_score < 0.05:
                    priority = "HIGH"
                elif occupancy_score < shelf.empty_threshold:
                    priority = "MEDIUM"
                else:
                    priority = "LOW"
                
                # Create message
                if needs_alert:
                    message = f"ALERT: {shelf.name} is {stock_level.lower()} and needs refilling!"
                else:
                    message = f"{shelf.name} is {stock_level.lower()}"
                
                result = {
                    'shelf_id': shelf.id,
                    'shelf_name': shelf.name,
                    'occupancy_score': occupancy_score,
                    'stock_level': stock_level,
                    'needs_alert': needs_alert,
                    'priority': priority,
                    'message': message,
                    'region': shelf_region,
                    'detected_items': [p['display_name'] for p in shelf_products]
                }
                
                results.append(result)
                
            except Exception as e:
                logger.error(f"Error processing shelf {shelf.id}: {str(e)}")
                results.append({
                    'shelf_id': shelf.id,
                    'shelf_name': shelf.name,
                    'error': str(e),
                    'occupancy_score': 0.0,
                    'stock_level': 'ERROR',
                    'needs_alert': False,
                    'priority': 'LOW',
                    'message': f"Error processing {shelf.name}",
                    'region': shelf.region,
                    'detected_items': []
                })
        
        return results
    
    def draw_analysis_overlay(self, frame: np.ndarray, results: List[Dict[str, Any]]) -> np.ndarray:
        """Draw analysis overlay on frame"""
        overlay_frame = frame.copy()
        
        for result in results:
            if 'region' not in result:
                continue
                
            x, y, w, h = result['region']
            
            # Determine color based on stock level
            stock_level = result.get('stock_level', 'UNKNOWN')
            if stock_level == 'EMPTY':
                color = (0, 0, 255)  # Red
            elif stock_level == 'LOW':
                color = (0, 165, 255)  # Orange
            elif stock_level == 'MEDIUM':
                color = (0, 255, 255)  # Yellow
            elif stock_level == 'HIGH':
                color = (0, 255, 0)  # Green
            else:
                color = (128, 128, 128)  # Gray for error
            
            # Draw rectangle
            cv2.rectangle(overlay_frame, (x, y), (x + w, y + h), color, 2)
            
            # Draw shelf info
            label = f"{result['shelf_name']} ({stock_level})"
            cv2.putText(overlay_frame, label, (x, y - 10), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
            
            # Draw occupancy score
            score_text = f"{result['occupancy_score']:.3f}"
            cv2.putText(overlay_frame, score_text, (x, y + h + 15), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
            
            # Draw detected items
            detected_items = result.get('detected_items', [])
            if detected_items:
                items_label = f"Items: {', '.join(detected_items)}"
                cv2.putText(overlay_frame, items_label, (x, y + h + 30), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
        
        return overlay_frame
