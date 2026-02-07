"use client";

import { useState, useRef, useEffect } from "react";

interface OptimizedVideoProps {
  src: string;
  webmSrc?: string;
  poster?: string;
  className?: string;
  style?: React.CSSProperties;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
}

export function OptimizedVideo({
  src,
  webmSrc,
  poster,
  className = "",
  style,
  autoPlay = true,
  muted = true,
  loop = true,
  playsInline = true,
}: OptimizedVideoProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Intersection Observer for lazy loading
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.1 }
    );

    if (videoRef.current) {
      observer.observe(videoRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // Handle video load
  const handleLoadedData = () => {
    setIsLoaded(true);
  };

  return (
    <div className={`relative ${className}`}>
      <video
        ref={videoRef}
        className={`transition-opacity duration-500 ${
          isLoaded ? "opacity-100" : "opacity-0"
        }`}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          position: 'absolute',
          inset: 0,
          ...style,
        }}
        autoPlay={autoPlay && isInView}
        muted={muted}
        loop={loop}
        playsInline={playsInline}
        poster={poster}
        onLoadStart={() => setIsLoaded(false)}
        onLoadedData={handleLoadedData}
        preload={isInView ? "metadata" : "none"}
      >
        {webmSrc && <source src={webmSrc} type="video/webm" />}
        <source src={src} type="video/mp4" />
        Your browser does not support the video tag.
      </video>
      
      {/* Loading placeholder */}
      {!isLoaded && (
        <div 
          className="absolute inset-0 bg-muted animate-pulse"
          style={{ 
            backgroundImage: poster ? `url(${poster})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      )}
    </div>
  );
}
