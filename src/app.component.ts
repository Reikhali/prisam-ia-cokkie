import { Component, signal, computed, OnInit, inject, DestroyRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';

// --- Interfaces ---

interface PrismaAnalysis {
  signal: 'COMPRA' | 'VENDA' | 'AGUARDAR';
  assertividade: number;
  reason: string;
  filters_status: {
    exaustao_detectada: boolean;
    descanso_identificado: boolean;
    pavios_favoraveis: boolean;
    sfp_presente: boolean;
    fluxo_confirmado: boolean;
    lateralizacao: boolean;
    suporte_resistencia: 'Em zona de suporte' | 'Em zona de resistência' | 'Neutro';
    tendencia_macro: 'A favor' | 'Contra' | 'Lateral';
  };
  next_candle_prediction: 'Alta' | 'Baixa' | 'Indefinida';
  risk_level: 'BAIXO' | 'MÉDIO' | 'ALTO';
  notes: string;
  timestamp: string;
}

interface TradeHistory {
  id: string;
  timestamp: string;
  signal: 'COMPRA' | 'VENDA';
  assertividade: number;
  result: 'WIN' | 'LOSS' | 'PENDING';
  profit: number;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styles: [`
    .chart-grid {
      background-image: 
        repeating-linear-gradient(90deg, transparent, transparent 99px, rgba(255, 255, 255, 0.03) 99px, rgba(255, 255, 255, 0.03) 100px),
        repeating-linear-gradient(0deg, transparent, transparent 49px, rgba(255, 255, 255, 0.03) 49px, rgba(255, 255, 255, 0.03) 50px);
    }
    .animate-pulse-fast {
      animation: pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.95); }
    }
    .history-scroll::-webkit-scrollbar { width: 6px; }
    .history-scroll::-webkit-scrollbar-track { background: #0f0f1e; }
    .history-scroll::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
  `]
})
export class AppComponent implements OnInit {
  // --- View Children for Capture ---
  @ViewChild('videoRef') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasRef') canvasElement!: ElementRef<HTMLCanvasElement>;

  // --- Global State ---
  currentTime = signal<string>('');
  timeframe = signal<'1M' | '5M' | '15M'>('1M');
  
  // --- Capture & Robot State ---
  stream = signal<MediaStream | null>(null);
  syncActive = signal<boolean>(false); // Robot Active state
  isAnalyzing = signal<boolean>(false);
  isPaused = signal<boolean>(false); // Stop Loss Trigger
  
  consecutiveLosses = signal<number>(0);
  countdown = signal<string>('PARADO');
  
  // --- Data ---
  currentAnalysis = signal<PrismaAnalysis | null>(null);
  tradeHistory = signal<TradeHistory[]>([]);
  
  // --- Derived Stats ---
  stats = computed(() => {
    const history = this.tradeHistory();
    const completed = history.filter(t => t.result !== 'PENDING');
    const wins = completed.filter(t => t.result === 'WIN').length;
    const losses = completed.filter(t => t.result === 'LOSS').length;
    const winRate = completed.length > 0 ? (wins / completed.length) * 100 : 0;
    
    return {
      total: completed.length,
      wins,
      losses,
      winRate: winRate.toFixed(1)
    };
  });

  private destroyRef = inject(DestroyRef);
  private syncTimer: any;
  private clockTimer: any;

  // --- PRISMA BRAIN CONTEXT (The Logic passed to AI) ---
  private readonly PRISMA_CONTEXT_INSTRUCTIONS = `
    PRISMA IA - ANÁLISE TÉCNICA AVANÇADA PARA OPÇÕES BINÁRIAS
    SEU PAPEL: Você é o PRISMA IA, um robô de análise técnica especializado em Price Action, Smart Money Concepts e estratégias de Real Traders.
    
    CHECKLIST OBRIGATÓRIO:
    1. EXAUSTÃO/DESCANSO: Corpo > 50% maior (Exaustão) ou Pequeno pós estouro (Descanso)?
    2. FILTRO 5 VELAS: Pavios longos superiores (Venda) ou inferiores (Compra)?
    3. SFP (Swing Failure Pattern): Rompimento falso de topo/fundo?
    4. FLUXO DE VELA: Vela de Força/Comando sem pavio contra?
    5. LATERALIZAÇÃO: Sequência de Dojis? (SE SIM, SINAL = AGUARDAR)
    6. ZONAS S/R: Engolfo, Martelo ou Estrela Cadente em zona?

    FORMATO JSON OBRIGATÓRIO:
    {
      "signal": "COMPRA" | "VENDA" | "AGUARDAR",
      "assertividade": "85-100",
      "reason": "Descrição técnica...",
      "filters_status": { ... },
      "next_candle_prediction": "Alta/Baixa",
      "risk_level": "BAIXO/MÉDIO/ALTO"
    }
  `;

  constructor() {
    this.clockTimer = setInterval(() => {
      this.currentTime.set(new Date().toLocaleTimeString('pt-BR'));
    }, 1000);

    this.destroyRef.onDestroy(() => {
      clearInterval(this.clockTimer);
      clearInterval(this.syncTimer);
      this.stopCapture();
    });
  }

  ngOnInit() {
    this.startSyncLoop();
    this.seedHistory();
  }

  // --- SCREEN CAPTURE LOGIC ---

  async startCapture() {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // @ts-ignore
          cursor: 'never'
        } as any,
        audio: false
      });
      
      this.stream.set(displayStream);
      
      if (this.videoElement?.nativeElement) {
        this.videoElement.nativeElement.srcObject = displayStream;
      }

      // Handle stream stop (user clicks "Stop Sharing" in browser UI)
      displayStream.getVideoTracks()[0].onended = () => {
        this.stopCapture();
      };

    } catch (err: any) {
      console.error("Erro ao compartilhar tela", err);
      alert("Erro ao iniciar captura: " + (err.message || "Permissão negada"));
    }
  }

  stopCapture() {
    const currentStream = this.stream();
    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
      this.stream.set(null);
      this.syncActive.set(false);
      this.countdown.set('PARADO');
    }
  }

  captureFrame(): string | null {
    if (this.videoElement?.nativeElement && this.canvasElement?.nativeElement) {
      const video = this.videoElement.nativeElement;
      const canvas = this.canvasElement.nativeElement;
      const context = canvas.getContext('2d');

      if (context && video.videoWidth > 0) {
        // Optimization: Max width 1280px
        const MAX_WIDTH = 1280;
        const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;

        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);

        // Optimization: JPEG 0.6
        return canvas.toDataURL('image/jpeg', 0.6);
      }
    }
    return null;
  }

  // --- T-10s SYNC LOGIC (The Core Engine) ---

  startSyncLoop() {
    // Check every second
    this.syncTimer = setInterval(() => {
      if (!this.syncActive() || !this.stream() || this.isPaused()) {
        this.countdown.set(this.syncActive() ? 'SINC...' : 'PARADO');
        return;
      }

      const delay = this.getNextTriggerTime();
      
      // Update UI Countdown
      const totalSeconds = Math.floor(delay / 1000);
      const min = Math.floor(totalSeconds / 60);
      const sec = totalSeconds % 60;
      this.countdown.set(`${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`);

      // TRIGGER EXECUTION (Window: 0ms to 1000ms)
      if (delay <= 1000 && delay > 0) {
        console.log(`🚀 T-10s DISPARO: Analisando ${this.timeframe()} às ${new Date().toLocaleTimeString()}`);
        this.executeAnalysisSequence();
      }

    }, 1000);
  }

  getNextTriggerTime(): number {
    const now = new Date();
    const ms = now.getMilliseconds();
    const s = now.getSeconds();
    const m = now.getMinutes();

    let timeToNextTop = 0;
    let intervalMs = 0;

    if (this.timeframe() === '1M') {
      timeToNextTop = (60 - s) * 1000 - ms;
      intervalMs = 60000;
    } else if (this.timeframe() === '5M') {
      const remainder = m % 5;
      const minutesToNext = 5 - remainder;
      timeToNextTop = (minutesToNext * 60 - s) * 1000 - ms;
      intervalMs = 300000;
    } else if (this.timeframe() === '15M') {
      const remainder = m % 15;
      const minutesToNext = 15 - remainder;
      timeToNextTop = (minutesToNext * 60 - s) * 1000 - ms;
      intervalMs = 900000;
    }

    // TARGET: 10 seconds BEFORE candle close (T-10s)
    const PRE_ANALYSIS_BUFFER = 10000; 
    let triggerDelay = timeToNextTop - PRE_ANALYSIS_BUFFER;

    // If we are already inside the 10s buffer (e.g. :55s), wait for next candle
    if (triggerDelay < 0) {
      triggerDelay += intervalMs;
    }

    return triggerDelay;
  }

  // --- ANALYSIS EXECUTION ---

  async executeAnalysisSequence() {
    if (this.isAnalyzing()) return;
    this.isAnalyzing.set(true);

    const imageData = this.captureFrame();
    
    // In a real app, we would send `imageData` + `this.PRISMA_CONTEXT_INSTRUCTIONS` to an API.
    // Since we are in preview mode without a backend key, we simulate the AI response
    // but the TRIGGER is real-time based on the screen capture logic.
    
    // Simulate API Latency (1.5s)
    setTimeout(() => {
      const result = this.generateRandomScenario(); // Simulating AI Brain decision
      this.currentAnalysis.set(result);
      
      if (result.signal !== 'AGUARDAR') {
        this.addTradeToHistory(result);
      }
      
      this.isAnalyzing.set(false);
    }, 1500);
  }

  toggleSync() {
    if (!this.stream()) {
      alert("Por favor, conecte a tela primeiro (Passo 1).");
      return;
    }
    this.syncActive.update(v => !v);
  }

  manualAnalysis() {
    if (!this.stream()) {
      alert("Conecte a tela primeiro.");
      return;
    }
    this.executeAnalysisSequence();
  }

  // --- HELPERS & MOCKS ---

  toggleTimeframe(tf: '1M' | '5M' | '15M') {
    this.timeframe.set(tf);
    // Reset sync slightly to recalculate timer immediately
    if (this.syncActive()) {
      this.syncActive.set(false);
      setTimeout(() => this.syncActive.set(true), 100);
    }
  }

  resetSystem() {
    this.isPaused.set(false);
    this.consecutiveLosses.set(0);
    this.syncActive.set(false);
  }

  addTradeToHistory(analysis: PrismaAnalysis) {
    const newTrade: TradeHistory = {
      id: Date.now().toString(),
      timestamp: new Date().toLocaleTimeString('pt-BR'),
      signal: analysis.signal as 'COMPRA' | 'VENDA',
      assertividade: analysis.assertividade,
      result: 'PENDING',
      profit: 0
    };

    // Simulate result after 3s (End of candle simulation)
    setTimeout(() => {
      const isWin = Math.random() > 0.2; // 80% mock win rate
      const result = isWin ? 'WIN' : 'LOSS';
      
      this.tradeHistory.update(prev => prev.map(t => {
        if (t.id === newTrade.id) {
          return { ...t, result, profit: isWin ? 50 : -50 };
        }
        return t;
      }));

      if (!isWin) {
        this.consecutiveLosses.update(v => v + 1);
        if (this.consecutiveLosses() >= 3) {
          this.isPaused.set(true);
          this.syncActive.set(false);
          alert('⛔ STOP LOSS ATIVADO: 3 Losses Consecutivos.');
        }
      } else {
        this.consecutiveLosses.set(0);
      }
    }, 3000);

    this.tradeHistory.update(prev => [newTrade, ...prev]);
  }

  seedHistory() {
    this.tradeHistory.set([
      { id: '1', timestamp: '10:00:00', signal: 'COMPRA', assertividade: 92, result: 'WIN', profit: 45 },
      { id: '2', timestamp: '10:05:00', signal: 'VENDA', assertividade: 88, result: 'WIN', profit: 45 },
    ]);
  }

  // Mock Scenario Generator (Same as before to keep demo functional)
  generateRandomScenario(): PrismaAnalysis {
    const rand = Math.random();
    // Reusing the scenarios from previous step for consistency
    return {
      signal: rand > 0.6 ? 'COMPRA' : (rand > 0.3 ? 'VENDA' : 'AGUARDAR'),
      assertividade: Math.floor(80 + Math.random() * 19),
      reason: "Análise realizada via Captura T-10s.\nVerificando padrões de fluxo e exaustão.",
      filters_status: {
        exaustao_detectada: rand < 0.2,
        descanso_identificado: rand > 0.8,
        pavios_favoraveis: true,
        sfp_presente: false,
        fluxo_confirmado: rand > 0.5,
        lateralizacao: false,
        suporte_resistencia: 'Neutro',
        tendencia_macro: 'A favor'
      },
      next_candle_prediction: 'Alta',
      risk_level: 'BAIXO',
      notes: "Sinal gerado pelo motor Prisma IA.",
      timestamp: new Date().toLocaleTimeString('pt-BR')
    };
  }
}