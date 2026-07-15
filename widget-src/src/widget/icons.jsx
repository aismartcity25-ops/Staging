// Icone del widget — basate su lucide-react. I nomi export restano quelli
// usati in ChatWidget.jsx/Message.jsx per non toccare il resto del codice.
// Le dimensioni sono passate esplicitamente solo dove non esiste già una
// regola CSS che sovrascrive width/height dell'svg.

import {
  MessageCircle as LucideMessageCircle,
  X,
  Send,
  Headphones,
  Paperclip,
  Image,
  Mic,
  MicOff,
  GripVertical,
  GripHorizontal,
  Volume2,
  Square,
  Copy,
  Check,
  ChevronDown,
  Loader2,
  Download,
  FileText
} from 'lucide-react';

export const MessageCircle = (props) => <LucideMessageCircle {...props} />;
export const XIcon = (props) => <X {...props} />;
export const SendIcon = (props) => <Send {...props} />;
export const HeadsetIcon = (props) => <Headphones {...props} />;
export const PaperclipIcon = (props) => <Paperclip {...props} />;
export const ImageIcon = (props) => <Image {...props} />;
export const MicIcon = (props) => <Mic {...props} />;
export const MicOffIcon = (props) => <MicOff {...props} />;

export const GripVerticalIcon = ({ size = 16, ...props }) => <GripVertical size={size} {...props} />;
export const GripHorizontalIcon = ({ size = 16, ...props }) => <GripHorizontal size={size} {...props} />;

export const VolumeIcon = (props) => <Volume2 size={14} {...props} />;
export const StopIcon = (props) => <Square size={14} {...props} />;
export const CopyIcon = (props) => <Copy size={11} {...props} />;
export const CheckIcon = (props) => <Check size={11} {...props} />;

export const ChevronDownIcon = (props) => <ChevronDown {...props} />;
export const LoaderIcon = (props) => <Loader2 {...props} />;
export const DownloadIcon = (props) => <Download size={14} {...props} />;
export const FileTextIcon = (props) => <FileText {...props} />;
