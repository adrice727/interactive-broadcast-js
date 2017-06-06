// @flow
import R from 'ramda';
import platform from 'platform';
import { toastr } from 'react-redux-toastr';
import { validateUser } from './auth';
import firebase from '../services/firebase';
import { connectToInteractive, setBroadcastEventStatus, setBackstageConnected } from './broadcast';
import { setInfo, resetAlert } from './alert';
import opentok from '../services/opentok';
import takeSnapshot from '../services/snapshot';
import { getEventWithCredentials } from '../services/api';

const { changeVolume, toggleLocalAudio, toggleLocalVideo } = opentok;

const setFanStatus: ActionCreator = (status: FanStatus): FanAction => ({
  type: 'SET_FAN_STATUS',
  status,
});

const setFanName: ActionCreator = (fanName: string): FanAction => ({
  type: 'SET_FAN_NAME',
  fanName,
});

const setAbleToJoin: ActionCreator = (ableToJoin: boolean): FanAction => ({
  type: 'SET_ABLE_TO_JOIN',
  ableToJoin,
});

const createSnapshot = async (publisher: Publisher): ImgData => {
  try {
    const fanSnapshot = await takeSnapshot(publisher.getImgData()); // $FlowFixMe @TODO: resolve flow error
    return fanSnapshot;
  } catch (error) {
    console.log('Failed to create fan snapshot'); // $FlowFixMe @TODO: resolve flow error
    return null;
  }
};

const removeActiveFanRecord: ThunkActionCreator = (event: BroadcastEvent): Thunk =>
  async (): AsyncVoid => {
    const fanId = firebase.auth().currentUser.uid;
    const { fanUrl, adminId } = event;
    const record = {
      id: fanId,
    };
    const ref = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}/activeFans/${fanId}`);
    try {
      ref.set(record);
    } catch (error) {
      console.log('Failed to remove active fan record: ', error);
    }
  };

const receivedChatMessage: ThunkActionCreator = (connection: Connection, message: ChatMessage): Thunk =>
  (dispatch: Dispatch, getState: GetState) => {
    const chatId = 'producer';
    const state = getState();
    const existingChat = R.pathOr(null, ['broadcast', 'chats', chatId], state);
    const fanType = (): ChatUser => {
      const status: FanStatus = R.path(['fan', 'fanStatus'], state);
      switch (status) {
        case 'inLine':
          return 'activeFan';
        case 'backstage':
          return 'backstageFan';
        case 'stage':
          return 'fan';
        default:
          return 'activeFan';
      }
    };
    const fromId = firebase.auth().currentUser.uid;
    const actions = [
      ({ type: 'START_NEW_PRODUCER_CHAT', fromType: fanType(), fromId, producer: { connection } }),
      ({ type: 'NEW_CHAT_MESSAGE', chatId, message: R.assoc('isMe', false, message) }),
    ];
    R.forEach(dispatch, existingChat ? R.tail(actions) : actions);
  };

const leaveTheLine: ThunkActionCreator = (): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const state = getState();
    const event = R.path(['broadcast', 'event'], state);
    const isLive = R.equals('live', event.status);
    const fanOnStage = R.equals('stage', R.path(['fan', 'status'], state));
    await opentok.disconnectFromInstance('backstage');
    if (fanOnStage) await isLive ? opentok.unpublish('stage') : opentok.endCall('stage');
    dispatch(setBackstageConnected(false));
    dispatch(removeActiveFanRecord(event));
    dispatch(setFanStatus('disconnected'));

  };


const onSignal = (dispatch: Dispatch, getState: GetState): SignalListener =>
  async ({ type, data, from }: Signal): AsyncVoid => {
    const state = getState();
    const signalData = data ? JSON.parse(data) : {};
    const signalType = R.last(R.split(':', type));
    const fromData = JSON.parse(from.data);
    const fromProducer = fromData.userType === 'producer';
    const isStage = R.equals(R.path(['fan', 'status'], state), 'stage');
    const instance = isStage ? 'stage' : 'backstage';

    /* If the sender of this signal is not the Producer, we should do nothing */
    if (!fromProducer) return;

    switch (signalType) {
      case 'goLive':
        dispatch(setBroadcastEventStatus('live'));
        opentok.subscribeAll('stage');
        break;
      case 'videoOnOff':
        toggleLocalVideo(instance, signalData.video === 'on');
        break;
      case 'muteAudio':
        toggleLocalAudio(instance, signalData.mute === 'off');
        break;
      case 'changeVolume':
        changeVolume('stage', signalData.userType, signalData.volume);
        break;
      case 'chatMessage':
        dispatch(receivedChatMessage(from, signalData));
        break;
      case 'privateCall': // @TODO
      case 'endPrivateCall': // @TODO
      case 'openChat': // @TODO
      case 'finishEvent':
        dispatch(setBroadcastEventStatus('closed'));
        break;
      case 'joinBackstage':
        dispatch(setFanStatus('backstage'));
        break;
      case 'disconnectBackstage':
        dispatch(setFanStatus('inLine'));
        break;
      case 'disconnect': {
        dispatch(leaveTheLine());
        const message = 'Thank you for participating, you are no longer sharing video/voice. You can continue to watch the session at your leisure.';
        toastr.success(message, { showCloseButton: false });
        break;
      }
      case 'joinHost':
        {
          /* Unpublish from backstage */
          await opentok.endCall('backstage');
          /* Display the going live alert */
          const options = (): AlertPartialOptions => ({
            title: '<h5>GOING LIVE NOW</h5>',
            text: '<h1><i class="fa fa-spinner fa-pulse"></i></h1>',
            showConfirmButton: false,
            html: true,
            type: null,
            allowEscapeKey: false,
          });
          dispatch(setInfo(options()));
          break;
        }
      case 'joinHostNow':
        {
          /* Change the status of the fan to 'stage' */
          dispatch(setFanStatus('stage'));
          /* Close the alert */
          dispatch(resetAlert());
          /* Start publishing to onstage */
          opentok.startCall('stage');
          /* Start subscribing from onstage */
          opentok.subscribeAll('stage');
          break;
        }
      default:
        break;
    }
  };

const createActiveFanRecord: ThunkActionCreator = (uid: UserId, adminId: string, fanUrl: string): Thunk =>
  async (): AsyncVoid => {

    /* Create a record in firebase */
    const record = {
      id: uid,
    };
    const fanRef = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}/activeFans/${uid}`);
    try {
      // Automatically remove the active fan record on disconnect event
      fanRef.onDisconnect().remove((error: Error): void => error && console.log(error));
      fanRef.set(record);
    } catch (error) {
      console.log(error);
    }
  };

const updateActiveFanRecord: ThunkActionCreator = (name: string, event: BroadcastEvent): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    const fanId = firebase.auth().currentUser.uid;
    const { adminId, fanUrl } = event;
    /* Create the snapshot and send it to the producer via firebase */
    const publisher = opentok.getPublisher('backstage');
    const record = {
      name,
      id: fanId,
      browser: platform.name,
      os: platform.os.family,
      mobile: platform.manufacturer !== null,
      snapshot: await createSnapshot(publisher),
      streamId: publisher.stream.streamId,
      isBackstage: false,
      inPrivateCall: false,
    };
    const fanRef = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}/activeFans/${fanId}`);
    try {
      fanRef.update(record);
      fanRef.on('value', (snapshot: firebase.database.DataSnapshot) => {
        const { inPrivateCall, isBackstage } = snapshot.val();
        isBackstage && dispatch(setFanStatus('backstage'));
        inPrivateCall && dispatch(setFanStatus('privateCall'));
      });
    } catch (error) {
      console.log(error);
    }
  };

const onStreamChanged: ThunkActionCreator = (user: UserRole, event: StreamEventType, stream: Stream, session: SessionName): Thunk =>
  (dispatch: Dispatch, getState: GetState) => {
    const state = getState();
    const isLive = R.equals('live', R.path(['broadcast', 'event', 'status'], state));
    const fanOnStage = R.equals('stage', R.path(['fan', 'status'], state));
    const userHasJoined = R.equals(event, 'streamCreated');
    const isStage = R.equals('stage', session);
    const subscribeStage = (isLive || fanOnStage) && userHasJoined && isStage;
    const subscribeBackStage = R.equals('producer', user) && !isStage;
    subscribeStage && opentok.subscribe('stage', stream);
    // Subscribe to producer audio for private call
    subscribeBackStage && opentok.subscribe('backstage', stream);
  };

const joinActiveFans: ThunkActionCreator = (fanName: string): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const event = R.path(['broadcast', 'event'], getState());
    try {
      dispatch(updateActiveFanRecord(fanName, event));
    } catch (error) {
      console.log(error);
    }
  };

const connectToPresence: ThunkActionCreator = (adminId: string, fanUrl: string): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const { uid } = await firebase.auth().signInAnonymously();
    const query = await firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}`).once('value');
    const activeBroadcast = query.val();
    const { activeFans, interactiveLimit } = activeBroadcast;
    const ableToJoin = !interactiveLimit || !activeFans || (activeFans && R.length(R.keys(activeFans)) < interactiveLimit);
    if (ableToJoin) {
      /* Create new record to update the presence */
      dispatch(createActiveFanRecord(uid, adminId, fanUrl));
      dispatch(setAbleToJoin);
      /* Get the event data */
      const data = { adminId, fanUrl, userType: 'fan' };
      const eventData: FanEventData = await getEventWithCredentials(data, getState().auth.authToken);
      dispatch({ type: 'SET_BROADCAST_EVENT', event: eventData });
      /* Connect to interactive */
      const credentialProps = ['apiKey', 'sessionId', 'stageSessionId', 'stageToken', 'backstageToken'];
      const credentials = R.pick(credentialProps, eventData);
      dispatch(connectToInteractive(credentials, 'fan', { onSignal: onSignal(dispatch, getState), onStreamChanged }, eventData));
    } else {
      console.log('Unable to join to interactive');
      // @TODO: Should display the HLS version or a message.
    }
  };

const initializeBroadcast: ThunkActionCreator = ({ adminId, userUrl }: FanInitOptions): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    try {
      // Get an Auth Token
      await dispatch(validateUser(adminId, 'fan', userUrl));

      // Connect to firebase and check the number of viewers
      await dispatch(connectToPresence(adminId, userUrl));

    } catch (error) {
      console.log('error', error);
    }
  };

const connectToBackstage: ThunkActionCreator = (fanName: string): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    /* Close the prompt */
    dispatch(resetAlert());
    /* Save the fan name in the storage */
    dispatch(setFanName(fanName || 'Anonymous'));
    /* Connect to backstage session */
    await opentok.connect(['backstage']);
    /* Save the new backstage connection state */
    dispatch(setBackstageConnected(true));
    /* Save the fan status  */
    dispatch(setFanStatus('inLine'));
    /* update the record in firebase adding the fan name + snapshot */
    dispatch(joinActiveFans(fanName));
  };

const getInLine: ThunkActionCreator = (): Thunk =>
  (dispatch: Dispatch, getState: GetState) => {
    const fanName = R.path(['fan', 'fanName'], getState());
    const options = (): AlertPartialOptions => ({
      title: 'Almost done!',
      text: 'You may enter you name below.',
      type: 'input',
      closeOnConfirm: false,
      inputPlaceholder: 'Name (Optional)',
      allowEscapeKey: false,
      html: true,
      confirmButtonColor: '#00a3e3',
      onConfirm: (inputValue: string): void => dispatch(connectToBackstage(inputValue)),
    });
    dispatch(fanName ? connectToBackstage(fanName) : setInfo(options()));
  };

module.exports = {
  initializeBroadcast,
  getInLine,
  leaveTheLine,
};
