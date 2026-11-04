import {Component} from 'react';
import type {ReactNode,ErrorInfo} from 'react';
import {Brand} from './components';
export default class PageRecovery extends Component<{children:ReactNode},{failed:boolean;updated:boolean}> {
  state={failed:false,updated:false};
  static getDerivedStateFromError(error:Error) {
    return {failed:true,updated:/dynamically imported|loading chunk|importing.*module|module script/i.test(error.message)};
  }
  componentDidCatch(_error:Error,_info:ErrorInfo) { /* Never report page data or connection credentials. */ }
  render() {
    if(!this.state.failed)return this.props.children;
    return <main className="page-recovery"><Brand/><h1>{this.state.updated?'TesPlay has been updated.':'This page couldn’t load.'}</h1><p>Reload to return to your screen. Your account, connections and saved progress are safe.</p><button className="button primary" onClick={()=>location.reload()}>Reload TesPlay</button></main>;
  }
}
