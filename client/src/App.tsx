import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import ReportHistory from "./pages/ReportHistory";
import AlgorithmPage from "./pages/AlgorithmPage";
import RealDataChart from "./pages/RealDataChart";

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/reports"} component={ReportHistory} />
      <Route path={"/algorithm"} component={AlgorithmPage} />
      <Route path={"/chart"} component={RealDataChart} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster theme="dark" position="bottom-right" />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
